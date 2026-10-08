import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_VERSION } from "../src/version.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("CLI configuration commands", () => {
  it.each(["0", "21", "1.5", "secret-input"])(
    "rejects invalid probe concurrency %s before loading config",
    (value) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "verify",
          "--config",
          "missing-config.yml",
          "--probe-concurrency",
          value,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("PROBE_CONCURRENCY_INVALID");
      expect(result.stderr).not.toContain("CONFIG_READ_FAILED");
      expect(result.stderr).not.toContain("secret-input");
    },
  );

  it("rejects invalid Action concurrency before loading config", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/action/index.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, "INPUT_PROBE-CONCURRENCY": "secret-input" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PROBE_CONCURRENCY_INVALID");
    expect(result.stdout).not.toContain("secret-input");
  });
  it("reports the package version", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--version"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(TOOL_VERSION);
  });

  it("initializes new configuration files with config v2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-witness-cli-"));
    dirs.push(dir);
    const path = join(dir, "deploy-witness.yml");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "init", "--output", path],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(await readFile(path, "utf8")).toContain("version: 2");
  });

  it("explains effective sources and planned checks without exposing values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deploy-witness-cli-"));
    dirs.push(dir);
    const path = join(dir, "deploy-witness.yml");
    await writeFile(
      path,
      `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://file-target.example.test\n  resourceUuid: private-resource-id\ndeployment:\n  expectedSha: ${"a".repeat(40)}\nprobes:\n  - name: health\n    url: https://runtime.example.test/health\n`,
    );

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "config", "explain", path],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_WITNESS_COOLIFY_BASE_URL:
            "https://environment-target.example.test",
          DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DEPLOY_WITNESS_COOLIFY_BASE_URL");
    expect(result.stdout).toContain("provider.coolify-api");
    expect(result.stdout).toContain("deployment.image-digest");
    expect(result.stdout).toContain("DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST");
    expect(result.stdout).toContain("http.health");
    expect(result.stdout).toContain("Configuration values and secret values");
    expect(result.stdout).not.toContain("private-resource-id");
    expect(result.stdout).not.toContain("environment-target.example.test");
    expect(result.stdout).not.toContain("file-target.example.test");
    expect(result.stdout).not.toContain("a".repeat(40));
    expect(result.stdout).not.toContain(`sha256:${"b".repeat(64)}`);
  });

  it("prints a machine-readable JSON Schema for config and report contracts", () => {
    for (const name of [
      "config",
      "config-v1",
      "config-v2",
      "report",
    ] as const) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "schema", name],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
    }
  });
});
