import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/contracts/index.js";
import { renderJUnit } from "../src/reporters/junit.js";
import {
  loadVerificationReport,
  MAX_REPORT_BYTES,
  parseVerificationReport,
} from "../src/reporters/load.js";
import { renderMarkdown } from "../src/reporters/markdown.js";
import { renderTerminal } from "../src/reporters/terminal.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(): Promise<VerificationReport> {
  return JSON.parse(
    await readFile("examples/report-pass-v1.json", "utf8"),
  ) as VerificationReport;
}
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "witness-report-"));
  directories.push(directory);
  return directory;
}
function command(path: string, extra: readonly string[] = []) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "report", path, ...extra],
    {
      encoding: "utf8",
      env: { ...process.env, COOLIFY_API_TOKEN: "", VERCEL_TOKEN: "" },
    },
  );
}

describe("saved report validation", () => {
  it("accepts historical v1 examples", async () => {
    for (const path of [
      "examples/report-pass-v1.json",
      "examples/report-stale-v1.json",
      "examples/report-pass-uncorrelated-v1.json",
    ]) {
      expect(await loadVerificationReport(path)).toEqual(
        JSON.parse(await readFile(path, "utf8")),
      );
    }
  });
  it("rejects forged decisions, duplicate IDs and vacuous reports", async () => {
    const report = await fixture();
    for (const value of [
      { ...report, decision: "FAIL" },
      { ...report, checks: [...report.checks, report.checks[0]] },
      { ...report, checks: [] },
      {
        ...report,
        checks: report.checks.map((check) => ({ ...check, required: false })),
      },
    ]) {
      expect(() => parseVerificationReport(value)).toThrow(
        "REPORT_INCONSISTENT",
      );
    }
  });
  it.each([null, {}, { schemaVersion: 2 }, { secret: "never-print-me" }])(
    "rejects invalid structures safely",
    (value) => {
      expect(() => parseVerificationReport(value)).toThrow("REPORT_INVALID");
      try {
        parseVerificationReport(value);
      } catch (error) {
        expect(String(error)).not.toContain("never-print-me");
      }
    },
  );
  it("enforces exact byte boundaries", async () => {
    const directory = await workspace();
    const path = join(directory, "report.json");
    const json = JSON.stringify(await fixture());
    await writeFile(
      path,
      json + " ".repeat(MAX_REPORT_BYTES - Buffer.byteLength(json)),
    );
    expect((await loadVerificationReport(path)).decision).toBe("PASS");
    await writeFile(
      path,
      json + " ".repeat(MAX_REPORT_BYTES + 1 - Buffer.byteLength(json)),
    );
    await expect(loadVerificationReport(path)).rejects.toThrow(
      "REPORT_TOO_LARGE",
    );
  });
  it("rejects invalid JSON and UTF-8 without echoing file contents", async () => {
    const directory = await workspace();
    const path = join(directory, "report.json");
    for (const value of [
      Buffer.from('{"token":"never-print-me"'),
      Buffer.from([0xff, 0xfe]),
    ]) {
      await writeFile(path, value);
      await expect(loadVerificationReport(path)).rejects.toThrow(
        "REPORT_INVALID",
      );
      const result = command(path);
      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("never-print-me");
    }
  });
  it("handles missing paths and directories safely", async () => {
    const directory = await workspace();
    for (const path of [directory, join(directory, "missing")]) {
      await expect(loadVerificationReport(path)).rejects.toThrow(
        "REPORT_READ_FAILED",
      );
    }
  });
  it("rejects named pipes without blocking for a writer", async () => {
    const path = join(await workspace(), "pipe");
    const created = spawnSync("mkfifo", [path]);
    expect(created.status).toBe(0);
    await expect(loadVerificationReport(path)).rejects.toThrow(
      "REPORT_READ_FAILED",
    );
  });
  it("removes terminal control characters and embedded newlines", async () => {
    const report = await fixture();
    const output = renderTerminal({
      ...report,
      checks: report.checks.map((check) => ({
        ...check,
        summary: "safe\u001b[2J\nforged\r\u009b\u2028line",
      })),
    });
    for (const character of ["\u001b", "\r", "\u009b", "\u2028"]) {
      expect(output).not.toContain(character);
    }
    expect(output.split("\n")).toHaveLength(report.checks.length + 1);
  });
  it("keeps JUnit valid when stored summaries contain XML-invalid characters", async () => {
    const report = await fixture();
    const check = report.checks[0];
    if (!check) throw new Error("Fixture must contain checks");
    const xml = renderJUnit({
      ...report,
      decision: "FAIL",
      checks: [
        {
          ...check,
          required: true,
          status: "FAIL",
          summary: "bad\u0000\u001b\ud800 <tag> 😀",
        },
      ],
    });
    for (const character of ["\u0000", "\u001b", "\ud800"])
      expect(xml).not.toContain(character);
    expect(xml).toContain("&lt;tag&gt; 😀");
  });
  it.each([
    ["PASS", "PASS", 0],
    ["FAIL", "FAIL", 1],
    ["UNKNOWN", "INCOMPLETE", 3],
  ] as const)(
    "preserves %s decision and exit code offline",
    async (status, decision, exitCode) => {
      const directory = await workspace();
      const path = join(directory, "report.json");
      const output = join(directory, "report.xml");
      const base = await fixture();
      await writeFile(
        path,
        JSON.stringify({
          ...base,
          decision,
          checks: [{ ...base.checks[0], status, required: true }],
        }),
      );
      const result = command(path, ["--junit", output]);
      expect(result.status).toBe(exitCode);
      expect(result.stdout).toContain(`Decision: ${decision}`);
      expect(await readFile(output, "utf8")).toContain(`value="${decision}"`);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    },
  );
  it("does not write JUnit for inconsistent reports", async () => {
    const directory = await workspace();
    const path = join(directory, "report.json");
    const output = join(directory, "report.xml");
    await writeFile(
      path,
      JSON.stringify({ ...(await fixture()), decision: "FAIL" }),
    );
    const result = command(path, ["--junit", output]);
    expect(result.status).toBe(2);
    await expect(stat(output)).rejects.toThrow();
  });
  it("exports offline Markdown and JUnit from the same report", async () => {
    const directory = await workspace();
    const path = join(directory, "report.json");
    const base = await fixture();
    await writeFile(path, JSON.stringify(base));
    const md = join(directory, "report.md");
    const xml = join(directory, "report.xml");
    const result = command(path, ["--markdown", md, "--junit", xml]);
    expect(result.status).toBe(0);
    expect(await readFile(md, "utf8")).toBe(renderMarkdown(base));
    expect((await stat(md)).mode & 0o777).toBe(0o600);
    expect(await readFile(xml, "utf8")).toBe(renderJUnit(base));
  });
  it("protects saved reports and rejects conflicting output paths before writing", async () => {
    const directory = await workspace();
    const path = join(directory, "report.json");
    const contents = JSON.stringify(await fixture());
    await writeFile(path, contents);
    const output = join(directory, "output");
    for (const extra of [
      ["--junit", path],
      ["--markdown", path],
      ["--junit", output, "--markdown", output],
    ]) {
      const result = command(path, extra);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("REPORT_OUTPUT_CONFLICT");
      expect(await readFile(path, "utf8")).toBe(contents);
      await expect(stat(output)).rejects.toThrow();
    }
  });
  it("reports output errors with exit 2", () => {
    const result = command("examples/report-pass-v1.json", [
      "--junit",
      "/missing-witness-dir/report.xml",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("REPORT_WRITE_FAILED");
  });
});
