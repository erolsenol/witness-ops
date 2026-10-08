import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

const workspace = process.cwd();
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "deploy-witness-consumer-"),
);

try {
  const packageDirectory = join(temporaryDirectory, "package");
  const consumerDirectory = join(temporaryDirectory, "consumer");
  mkdirSync(packageDirectory);
  mkdirSync(consumerDirectory);
  const packed = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packageDirectory,
      ],
      { cwd: workspace },
    ),
  );
  const packEntry = Array.isArray(packed)
    ? packed[0]
    : packed?.["deploy-witness"];
  const archiveName = packEntry?.filename;
  if (typeof archiveName !== "string")
    throw new Error("PACKED_ARCHIVE_MISSING");

  const archivePath = join(packageDirectory, archiveName);
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerDirectory,
      archivePath,
    ],
    { cwd: workspace },
  );

  const installedCli = join(
    consumerDirectory,
    "node_modules",
    "deploy-witness",
    "dist",
    "cli.js",
  );
  const metadata = JSON.parse(
    readFileSync(join(workspace, "package.json"), "utf8"),
  );
  const version = run(process.execPath, [installedCli, "--version"], {
    cwd: consumerDirectory,
  }).trim();
  if (version !== metadata.version)
    throw new Error("PACKED_CLI_VERSION_MISMATCH");

  const schema = JSON.parse(
    run(process.execPath, [installedCli, "schema", "config-v2"], {
      cwd: consumerDirectory,
    }),
  );
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema")
    throw new Error("PACKED_SCHEMA_INVALID");

  const savedReport = join(workspace, "examples", "report-pass-v1.json");
  const savedOutput = run(
    process.execPath,
    [
      installedCli,
      "report",
      savedReport,
      "--junit",
      join(consumerDirectory, "report.xml"),
      "--markdown",
      join(consumerDirectory, "report.md"),
    ],
    { cwd: consumerDirectory },
  );
  if (!savedOutput.includes("Decision: PASS"))
    throw new Error("PACKED_REPORT_COMMAND_FAILED");

  const importCheck = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { VerificationConfigSchema, parseProbeConcurrency, httpProbeCheckId, parseVerificationReport, loadVerificationReport, renderMarkdown, writeReportArtifacts } from 'deploy-witness'; if (typeof renderMarkdown !== 'function' || typeof writeReportArtifacts !== 'function' || typeof parseVerificationReport !== 'function' || typeof loadVerificationReport !== 'function' || !VerificationConfigSchema.safeParse({ version: 2, provider: 'coolify', coolify: { baseUrl: 'https://coolify.example.test', resourceUuid: 'consumer' }, deployment: {}, probes: [] }).success || parseProbeConcurrency() !== 4 || httpProbeCheckId('Runtime Version') !== 'http.runtime-version') process.exit(1)",
    ],
    { cwd: consumerDirectory },
  );
  if (importCheck !== "") throw new Error("PACKED_API_OUTPUT_UNEXPECTED");

  if (
    !existsSync(
      join(consumerDirectory, "node_modules", "deploy-witness", "action.yml"),
    )
  )
    throw new Error("PACKED_ACTION_MANIFEST_MISSING");

  if (
    !existsSync(
      join(
        consumerDirectory,
        "node_modules",
        "deploy-witness",
        "docs",
        "support-policy.md",
      ),
    )
  )
    throw new Error("PACKED_SUPPORT_POLICY_MISSING");

  if (
    !existsSync(
      join(
        consumerDirectory,
        "node_modules",
        "deploy-witness",
        "docs",
        "adr",
        "0003-github-artifact-attestation.md",
      ),
    )
  )
    throw new Error("PACKED_ATTESTATION_ADR_MISSING");

  console.log(
    `Packed consumer smoke passed for deploy-witness@${metadata.version}.`,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
