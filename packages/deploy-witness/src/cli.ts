#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  CONFIG_ENV_OVERRIDES,
  ConfigLoadError,
  loadConfig,
  loadConfigDetails,
} from "./config/load.js";
import { httpProbeCheckId } from "./contracts/index.js";
import {
  createPublicJsonSchema,
  type PublicSchemaName,
} from "./contracts/json-schema.js";
import {
  ProbeConcurrencyError,
  parseProbeConcurrency,
} from "./core/probe-options.js";
import { runVerification } from "./core/verify.js";
import {
  type ReportArtifact,
  ReportWriteError,
  writeReportArtifacts,
} from "./reporters/artifacts.js";
import { renderJUnit } from "./reporters/junit.js";
import { loadVerificationReport, ReportLoadError } from "./reporters/load.js";
import { renderMarkdown } from "./reporters/markdown.js";
import { renderTerminal, verificationExitCode } from "./reporters/terminal.js";
import { TOOL_VERSION } from "./version.js";

const program = new Command()
  .name(process.env.WITNESS_OPS_CLI_GROUP === "deploy" ? "witness deploy" : "deploy-witness")
  .description("Verify that the expected commit is live after deployment.")
  .version(TOOL_VERSION);
const templates = {
  coolify: `version: 2\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.com\n  resourceUuid: replace-with-resource-uuid\ndeployment:\n  timeoutSeconds: 600\n  pollIntervalSeconds: 5\nprobes: []\n`,
  vercel: `version: 2\nprovider: vercel\nvercel:\n  projectId: replace-with-vercel-project-id\n  target: production\ndeployment:\n  timeoutSeconds: 600\n  pollIntervalSeconds: 5\nprobes: []\n`,
} as const;

program
  .command("init")
  .description(
    "Create a starter configuration without overwriting existing files.",
  )
  .option("-o, --output <path>", "output path", "deploy-witness.yml")
  .option("--provider <provider>", "coolify or vercel", "coolify")
  .action(
    async ({ output, provider }: { output: string; provider: string }) => {
      if (provider !== "coolify" && provider !== "vercel") {
        console.error("PROVIDER_INVALID: Choose coolify or vercel.");
        process.exitCode = 2;
        return;
      }
      try {
        await writeFile(output, templates[provider], {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        console.log(`Created ${output}`);
      } catch {
        console.error(
          "Could not create configuration (the path may already exist).",
        );
        process.exitCode = 2;
      }
    },
  );

const configCommand = program
  .command("config")
  .description("Configuration commands");

configCommand
  .command("validate")
  .argument("[path]", "configuration file", "deploy-witness.yml")
  .action(async (path: string) => {
    try {
      await loadConfig(path);
      console.log("Configuration is valid.");
    } catch (error) {
      console.error(
        error instanceof ConfigLoadError
          ? `${error.code}: ${error.message}`
          : "CONFIG_INVALID: Configuration could not be validated.",
      );
      process.exitCode = 2;
    }
  });

program
  .command("schema")
  .description("Print or write a public JSON Schema contract.")
  .argument("<name>", "schema name: config, config-v1, config-v2, or report")
  .option("-o, --output <path>", "write JSON Schema to a file")
  .action(async (name: string, options: { output?: string }) => {
    if (
      name !== "config" &&
      name !== "config-v1" &&
      name !== "config-v2" &&
      name !== "report"
    ) {
      console.error(
        "SCHEMA_NAME_INVALID: Choose config, config-v1, config-v2, or report.",
      );
      process.exitCode = 2;
      return;
    }
    const schema = `${JSON.stringify(createPublicJsonSchema(name as PublicSchemaName), null, 2)}\n`;
    if (options.output) {
      try {
        await writeFile(options.output, schema, {
          encoding: "utf8",
          mode: 0o644,
        });
      } catch {
        console.error("SCHEMA_WRITE_FAILED: Schema file could not be written.");
        process.exitCode = 2;
      }
    } else {
      process.stdout.write(schema);
    }
  });

configCommand
  .command("explain")
  .description("Show the effective configuration source and planned checks.")
  .argument("[path]", "configuration file", "deploy-witness.yml")
  .action(async (path: string) => {
    try {
      const loaded = await loadConfigDetails(path);
      const probeIds = loaded.config.probes.map((probe) =>
        httpProbeCheckId(probe.name),
      );
      console.log(`Configuration source: ${loaded.path}`);
      console.log(
        "Precedence: CLI options > DEPLOY_WITNESS_* environment > config file > CI defaults",
      );
      console.log(
        `Applied environment overrides: ${loaded.appliedOverrides.join(", ") || "none"}`,
      );
      console.log("Planned checks:");
      for (const id of [
        loaded.config.provider === "coolify"
          ? "provider.coolify-api"
          : "provider.vercel-api",
        "deployment.status",
        "deployment.commit",
        "deployment.freshness",
        ...(("expectedImageDigest" in loaded.config.deployment &&
          loaded.config.deployment.expectedImageDigest) ||
        process.env.DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST
          ? ["deployment.image-digest"]
          : []),
        ...probeIds,
      ]) {
        console.log(`  - ${id}`);
      }
      console.log(
        "Configuration values and secret values are intentionally not displayed.",
      );
    } catch (error) {
      console.error(
        error instanceof ConfigLoadError
          ? `${error.code}: ${error.message}`
          : "CONFIG_INVALID: Configuration could not be inspected.",
      );
      process.exitCode = 2;
    }
  });

program
  .command("verify")
  .description("Verify a deployment and configured runtime probes.")
  .option("-c, --config <path>", "configuration file", "deploy-witness.yml")
  .option("--expected-sha <sha>", "expected full commit SHA")
  .option(
    "--started-after <timestamp>",
    "deployment-run boundary timestamp (ISO 8601)",
  )
  .option(
    "--expected-image-digest <digest>",
    "expected immutable OCI image digest (sha256:<64 hex characters>)",
  )
  .option("--report <path>", "write JSON evidence report")
  .option(
    "--probe-concurrency <count>",
    "maximum concurrent runtime probes (1–20)",
    "4",
  )
  .option("--junit <path>", "write JUnit XML check results")
  .option("--markdown <path>", "write Markdown evidence summary")
  .action(
    async (options: {
      config: string;
      expectedSha?: string;
      startedAfter?: string;
      expectedImageDigest?: string;
      report?: string;
      junit?: string;
      markdown?: string;
      probeConcurrency: string;
    }) => {
      try {
        const probeConcurrency = parseProbeConcurrency(
          options.probeConcurrency,
        );
        if (
          options.expectedImageDigest !== undefined &&
          !/^sha256:[a-f0-9]{64}$/i.test(options.expectedImageDigest)
        ) {
          console.error(
            "EXPECTED_IMAGE_DIGEST_INVALID: Provide sha256: followed by 64 hexadecimal characters.",
          );
          process.exitCode = 2;
          return;
        }
        const configEnv = options.expectedImageDigest
          ? {
              ...process.env,
              [CONFIG_ENV_OVERRIDES.expectedImageDigest]:
                options.expectedImageDigest,
            }
          : process.env;
        const config = await loadConfig(options.config, { env: configEnv });
        const expectedSha =
          options.expectedSha ??
          config.deployment.expectedSha ??
          process.env.GITHUB_SHA;
        if (!expectedSha || !/^[a-f0-9]{40,64}$/i.test(expectedSha)) {
          console.error(
            "EXPECTED_SHA_INVALID: Provide a full 40–64 character commit SHA.",
          );
          process.exitCode = 2;
          return;
        }
        const token =
          config.provider === "coolify"
            ? process.env.COOLIFY_API_TOKEN
            : process.env.VERCEL_TOKEN;
        if (!token) {
          console.error(
            config.provider === "coolify"
              ? "COOLIFY_TOKEN_MISSING: Set COOLIFY_API_TOKEN in the environment."
              : "VERCEL_TOKEN_MISSING: Set VERCEL_TOKEN in the environment.",
          );
          process.exitCode = 2;
          return;
        }
        const expectedImageDigest =
          options.expectedImageDigest ??
          process.env.DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST ??
          ("expectedImageDigest" in config.deployment
            ? config.deployment.expectedImageDigest
            : undefined);
        if (
          expectedImageDigest !== undefined &&
          !/^sha256:[a-f0-9]{64}$/i.test(expectedImageDigest)
        ) {
          console.error(
            "EXPECTED_IMAGE_DIGEST_INVALID: Provide sha256: followed by 64 hexadecimal characters.",
          );
          process.exitCode = 2;
          return;
        }
        const report = await runVerification({
          probeConcurrency,
          config,
          token,
          expectedSha,
          ...(options.startedAfter
            ? { startedAfter: options.startedAfter }
            : {}),
          ...(expectedImageDigest ? { expectedImageDigest } : {}),
        });
        const artifacts: ReportArtifact[] = [];
        if (options.report)
          artifacts.push({
            path: options.report,
            contents: `${JSON.stringify(report, null, 2)}\n`,
          });
        if (options.junit)
          artifacts.push({
            path: options.junit,
            contents: renderJUnit(report),
          });
        if (options.markdown)
          artifacts.push({
            path: options.markdown,
            contents: renderMarkdown(report),
          });
        await writeReportArtifacts(artifacts, [options.config]);
        console.log(renderTerminal(report));
        process.exitCode = verificationExitCode(report);
      } catch (error) {
        if (error instanceof ReportWriteError) {
          console.error(error.message);
          process.exitCode = 2;
          return;
        }
        if (error instanceof ProbeConcurrencyError) {
          console.error(error.message);
          process.exitCode = 2;
          return;
        }
        if (
          error instanceof Error &&
          error.message === "STARTED_AFTER_INVALID"
        ) {
          console.error(
            "STARTED_AFTER_INVALID: Provide a valid ISO 8601 timestamp with a timezone.",
          );
          process.exitCode = 2;
          return;
        }
        console.error(
          error instanceof ConfigLoadError
            ? `${error.code}: ${error.message}`
            : "VERIFY_FAILED: Verification could not be completed safely.",
        );
        process.exitCode = error instanceof ConfigLoadError ? 2 : 3;
      }
    },
  );

program
  .command("report")
  .description(
    "Validate saved JSON evidence offline and optionally export JUnit.",
  )
  .argument("<path>", "saved JSON report (maximum 4 MiB)")
  .option("--junit <path>", "write JUnit XML check results")
  .option("--markdown <path>", "write Markdown evidence summary")
  .action(
    async (path: string, options: { junit?: string; markdown?: string }) => {
      try {
        const report = await loadVerificationReport(path);
        const artifacts: ReportArtifact[] = [];
        if (options.junit)
          artifacts.push({
            path: options.junit,
            contents: renderJUnit(report),
          });
        if (options.markdown)
          artifacts.push({
            path: options.markdown,
            contents: renderMarkdown(report),
          });
        await writeReportArtifacts(artifacts, [path]);
        console.log(renderTerminal(report));
        process.exitCode = verificationExitCode(report);
      } catch (error) {
        console.error(
          error instanceof ReportLoadError || error instanceof ReportWriteError
            ? error.message
            : "REPORT_WRITE_FAILED: JUnit file could not be written.",
        );
        process.exitCode = 2;
      }
    },
  );

program.parseAsync().catch(() => {
  console.error(
    `COMMAND_FAILED: Could not run command (reference ${randomUUID()}).`,
  );
  process.exitCode = 2;
});
