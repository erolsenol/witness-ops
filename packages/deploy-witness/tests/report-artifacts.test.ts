import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeReportArtifacts } from "../src/reporters/artifacts.js";

const failure = vi.hoisted(() => ({ rename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (failure.rename) throw new Error("private filesystem error");
      return original.rename(...args);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  failure.rename = false;
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "witness-artifacts-"));
  directories.push(path);
  return path;
}

describe("report artifact writer", () => {
  it("creates and replaces complete artifacts with private permissions", async () => {
    const directory = await workspace();
    const path = join(directory, "report.json");
    await writeFile(path, "previous", { mode: 0o644 });
    await writeReportArtifacts([
      { path, contents: "complete" },
      { path: join(directory, "report.md"), contents: "summary" },
    ]);
    expect(await readFile(path, "utf8")).toBe("complete");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "report.md"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["report.json", "report.md"]);
  });
  it("preflights every output before changing any file", async () => {
    const directory = await workspace();
    const path = join(directory, "existing");
    await writeFile(path, "preserve");
    await expect(
      writeReportArtifacts([
        { path, contents: "changed" },
        { path: join(directory, "missing", "report"), contents: "second" },
      ]),
    ).rejects.toThrow("REPORT_WRITE_FAILED");
    expect(await readFile(path, "utf8")).toBe("preserve");
    expect(await readdir(directory)).toEqual(["existing"]);
  });
  it("protects sources through lexical aliases, symlinks and hard links", async () => {
    const directory = await workspace();
    const source = join(directory, "source.json");
    const hard = join(directory, "hard.json");
    const symbolic = join(directory, "symbolic.json");
    await writeFile(source, "evidence");
    await link(source, hard);
    await symlink(source, symbolic);
    for (const path of [
      source,
      join(directory, ".", "source.json"),
      hard,
      symbolic,
    ]) {
      await expect(
        writeReportArtifacts([{ path, contents: "destroy" }], [source]),
      ).rejects.toThrow("REPORT_OUTPUT_CONFLICT");
    }
    expect(await readFile(source, "utf8")).toBe("evidence");
  });
  it("rejects output aliases through a symlinked parent directory", async () => {
    const directory = await workspace();
    const alias = join(await workspace(), "alias");
    await symlink(directory, alias);
    const source = join(directory, "source.json");
    await writeFile(source, "evidence");
    await expect(
      writeReportArtifacts(
        [{ path: join(alias, "source.json"), contents: "destroy" }],
        [source],
      ),
    ).rejects.toThrow("REPORT_OUTPUT_CONFLICT");
    await expect(
      writeReportArtifacts([
        { path: join(directory, "new"), contents: "one" },
        { path: join(alias, "new"), contents: "two" },
      ]),
    ).rejects.toThrow("REPORT_OUTPUT_CONFLICT");
    expect(await readFile(source, "utf8")).toBe("evidence");
  });
  it("rejects duplicate outputs and existing hard-link aliases", async () => {
    const directory = await workspace();
    const first = join(directory, "one");
    const second = join(directory, "two");
    await writeFile(first, "preserve");
    await link(first, second);
    for (const paths of [
      [first, first],
      [first, second],
    ]) {
      await expect(
        writeReportArtifacts(
          paths.map((path) => ({ path, contents: "changed" })),
        ),
      ).rejects.toThrow("REPORT_OUTPUT_CONFLICT");
    }
    expect(await readFile(first, "utf8")).toBe("preserve");
  });
  it("rejects dangling symlinks and non-file destinations", async () => {
    const directory = await workspace();
    const dangling = join(directory, "dangling");
    await symlink(join(directory, "missing"), dangling);
    for (const path of [directory, dangling]) {
      await expect(
        writeReportArtifacts([{ path, contents: "changed" }]),
      ).rejects.toThrow("REPORT_OUTPUT_CONFLICT");
    }
    expect(await readdir(directory)).toEqual(["dangling"]);
  });
  it("preserves the original and cleans temporary files when rename fails", async () => {
    const directory = await workspace();
    const path = join(directory, "report");
    await writeFile(path, "preserve");
    failure.rename = true;
    await expect(
      writeReportArtifacts([{ path, contents: "new" }]),
    ).rejects.toThrow("REPORT_WRITE_FAILED");
    expect(await readFile(path, "utf8")).toBe("preserve");
    expect(await readdir(directory)).toEqual(["report"]);
  });
  it("skips source lookup when no output is requested", async () => {
    await expect(
      writeReportArtifacts([], ["missing-source"]),
    ).resolves.toBeUndefined();
  });
});
