import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import {
  type CheckResult,
  type VerificationReport,
  VerificationReportSchema,
} from "../src/contracts/index.js";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const commit = "a".repeat(40);
const stagingEnvironment = {
  DW_STAGING_COOLIFY_BASE_URL: "https://coolify.example.test",
  DW_STAGING_COOLIFY_RESOURCE_UUID: "staging-resource-uuid",
  DW_STAGING_HEALTH_URL: "https://app.example.test/health",
  DW_STAGING_VERSION_URL: "https://app.example.test/api/version",
  DW_STAGING_VERSION_JSON_PATH: "build.commit",
  DW_STAGING_EXPECTED_SHA: commit,
  DW_STAGING_STARTED_AFTER: "2026-10-01T10:00:00.000Z",
  DW_STAGING_CONFIRM_NONPRODUCTION: "true",
};

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "deploy-witness-staging-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runNodeScript(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  const isTypeScript = script.endsWith(".ts");
  const executableArgs = isTypeScript
    ? [require.resolve("tsx/cli"), resolve(script), ...args]
    : [resolve(script), ...args];
  return spawnSync(process.execPath, executableArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Coolify staging workflow helpers", () => {
  it("creates private positive and negative configs with valid v2 contracts", async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = join(directory, "github-output");
    await writeFile(outputPath, "", { mode: 0o600 });

    const result = runNodeScript("scripts/create-staging-config.mjs", [], {
      ...stagingEnvironment,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: outputPath,
    });
    expect(result.status, result.stderr).toBe(0);

    const outputs = Object.fromEntries(
      (await readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const positive = JSON.parse(
      await readFile(outputs.positive_config as string, "utf8"),
    );
    const shaMismatch = JSON.parse(
      await readFile(outputs.sha_mismatch_config as string, "utf8"),
    );
    const markerMismatch = JSON.parse(
      await readFile(outputs.marker_mismatch_config as string, "utf8"),
    );

    expect(positive.probes[1].expectedJson).toEqual({
      path: "build.commit",
      value: commit,
    });
    expect(shaMismatch.probes[1].expectedJson).toEqual(
      positive.probes[1].expectedJson,
    );
    expect(outputs.sha_mismatch_expected).not.toBe(commit);
    expect(markerMismatch.probes[1].expectedJson.value).not.toBe(commit);
    for (const key of [
      "positive_config",
      "sha_mismatch_config",
      "marker_mismatch_config",
    ]) {
      const config = JSON.parse(await readFile(outputs[key] as string, "utf8"));
      const validatedConfig = await loadConfig(outputs[key] as string);
      expect(validatedConfig.provider).toBe("coolify");
      expect(config.deployment.timeoutSeconds).toBe(120);
      expect((await stat(outputs[key] as string)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a non-HTTPS health target before writing any configs", async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = join(directory, "github-output");
    await writeFile(outputPath, "", { mode: 0o600 });

    const result = runNodeScript("scripts/create-staging-config.mjs", [], {
      ...stagingEnvironment,
      DW_STAGING_HEALTH_URL: "http://app.example.test/health",
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: outputPath,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DW_STAGING_HEALTH_URL must use HTTPS.");
    expect((await readFile(outputPath, "utf8")).trim()).toBe("");
  });

  it("requires explicit confirmation that the resource is non-production", async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = join(directory, "github-output");
    await writeFile(outputPath, "", { mode: 0o600 });

    const result = runNodeScript("scripts/create-staging-config.mjs", [], {
      ...stagingEnvironment,
      DW_STAGING_CONFIRM_NONPRODUCTION: undefined,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: outputPath,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Confirm the Coolify resource is non-production before running staging E2E.",
    );
    expect((await readFile(outputPath, "utf8")).trim()).toBe("");
  });

  it("accepts the wrong-SHA control only when the provider commit fails", async () => {
    const directory = await makeTemporaryDirectory();
    const token = "test-only-provider-token";
    const report = makeReport("FAIL", {
      "deployment.commit": {
        status: "FAIL",
        failureCode: "DEPLOYMENT_SHA_MISMATCH",
      },
    });
    const reportPath = await writeReport(directory, report);

    const result = runNodeScript(
      "scripts/check-staging-report.ts",
      ["sha-mismatch", reportPath],
      { DW_STAGING_COOLIFY_TOKEN: token },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a wrong-marker report if the provider SHA also mismatches", async () => {
    const directory = await makeTemporaryDirectory();
    const report = makeReport("FAIL", {
      "deployment.commit": {
        status: "FAIL",
        failureCode: "DEPLOYMENT_SHA_MISMATCH",
      },
      "http.staging-commit": { status: "FAIL" },
    });
    const reportPath = await writeReport(directory, report);

    const result = runNodeScript(
      "scripts/check-staging-report.ts",
      ["marker-mismatch", reportPath],
      { DW_STAGING_COOLIFY_TOKEN: "test-only-provider-token" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "The deployment SHA must remain correct for the marker control.",
    );
  });

  it("rejects reports containing the configured provider token", async () => {
    const directory = await makeTemporaryDirectory();
    const token = "test-only-provider-token";
    const report = makeReport("PASS", {}, token);
    const reportPath = await writeReport(directory, report);

    const result = runNodeScript(
      "scripts/check-staging-report.ts",
      ["positive", reportPath],
      { DW_STAGING_COOLIFY_TOKEN: token },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "A provider token was found in the verification report.",
    );
  });
});

function makeReport(
  decision: VerificationReport["decision"],
  overrides: Record<string, Partial<CheckResult>>,
  token?: string,
): VerificationReport {
  const timestamp = "2026-10-01T10:10:00.000Z";
  const checks: CheckResult[] = [
    "deployment.status",
    "deployment.commit",
    "deployment.freshness",
    "http.staging-health",
    "http.staging-commit",
  ].map((id) => ({
    id,
    category: id.startsWith("http.") ? "runtime" : "deployment",
    required: true,
    status: "PASS",
    summary: "Synthetic staging check.",
    durationMs: 1,
    evidence: token
      ? [
          {
            source: "test",
            observedAt: timestamp,
            field: "token",
            observed: token,
          },
        ]
      : [],
    ...overrides[id],
  }));

  return VerificationReportSchema.parse({
    schemaVersion: 1,
    toolVersion: "0.2.7",
    runId: "33333333-3333-4333-8333-333333333333",
    createdAt: timestamp,
    expectedSha: commit,
    provider: "coolify",
    resourceUuid: "staging-resource-uuid",
    decision,
    capabilities: [],
    checks,
  });
}

async function writeReport(
  directory: string,
  report: VerificationReport,
): Promise<string> {
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, JSON.stringify(report), { mode: 0o600 });
  return reportPath;
}
