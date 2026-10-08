import { randomUUID } from "node:crypto";
import type {
  CheckResult,
  VerificationConfig,
  VerificationReport,
} from "../contracts/index.js";
import {
  decide,
  httpProbeCheckId,
  VerificationReportSchema,
} from "../contracts/index.js";
import { verifyHttpProbe } from "../probes/http.js";
import { providerCapabilities } from "../providers/capabilities.js";
import { verifyCoolifyDeployment } from "../providers/coolify/verify.js";
import { evaluateImageDigestEvidence } from "../providers/deployment-evidence.js";
import { verifyVercelDeployment } from "../providers/vercel/verify.js";
import { TOOL_VERSION } from "../version.js";
import { parseProbeConcurrency } from "./probe-options.js";

export interface RunVerificationOptions {
  readonly config: VerificationConfig;
  readonly token: string;
  readonly expectedSha: string;
  readonly startedAfter?: string;
  readonly expectedImageDigest?: string;
  readonly probeConcurrency?: number;
  readonly fetchImpl?: typeof fetch;
}

const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;

function skippedRuntimeChecks(
  config: VerificationConfig,
  summary: string,
): readonly CheckResult[] {
  return config.probes.map((probe) => ({
    id: httpProbeCheckId(probe.name),
    category: "runtime",
    required: probe.required,
    status: "SKIP",
    summary,
    durationMs: 0,
    evidence: [],
    failureCode: "RUNTIME_CHECK_NOT_RUN",
  }));
}

export async function runVerification(
  options: RunVerificationOptions,
): Promise<VerificationReport> {
  const { config } = options;
  const probeConcurrency = parseProbeConcurrency(options.probeConcurrency);
  const startedAfter = options.startedAfter ?? config.deployment.startedAfter;
  const expectedImageDigest =
    options.expectedImageDigest ??
    ("expectedImageDigest" in config.deployment
      ? config.deployment.expectedImageDigest
      : undefined);
  if (
    startedAfter !== undefined &&
    !Number.isFinite(Date.parse(startedAfter))
  ) {
    throw new Error("STARTED_AFTER_INVALID");
  }
  if (
    expectedImageDigest !== undefined &&
    !IMAGE_DIGEST_PATTERN.test(expectedImageDigest)
  ) {
    throw new Error("EXPECTED_IMAGE_DIGEST_INVALID");
  }
  if (
    config.probes.some(
      (probe) =>
        "imageDigestJsonPath" in probe && Boolean(probe.imageDigestJsonPath),
    ) &&
    expectedImageDigest === undefined
  ) {
    throw new Error("EXPECTED_IMAGE_DIGEST_REQUIRED");
  }
  const providerChecks =
    config.provider === "coolify"
      ? await verifyCoolifyDeployment({
          baseUrl: config.coolify.baseUrl,
          resourceUuid: config.coolify.resourceUuid,
          token: options.token,
          expectedSha: options.expectedSha,
          ...(startedAfter ? { startedAfter } : {}),
          timeoutSeconds: config.deployment.timeoutSeconds,
          pollIntervalSeconds: config.deployment.pollIntervalSeconds,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
      : await verifyVercelDeployment({
          config,
          token: options.token,
          expectedSha: options.expectedSha,
          ...(startedAfter ? { startedAfter } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });

  const deploymentVerified = providerChecks
    .filter((result) =>
      [
        "provider.coolify-api",
        "provider.vercel-api",
        "deployment.status",
        "deployment.commit",
        "deployment.freshness",
      ].includes(result.id),
    )
    .every((result) => !result.required || result.status === "PASS");
  const providerApiAvailable = providerChecks.some(
    (result) =>
      result.id.endsWith("-api") &&
      result.category === "provider" &&
      result.status === "PASS",
  );

  const runtimeChecks = deploymentVerified
    ? await (async () => {
        const results: CheckResult[] = new Array(config.probes.length);
        let nextIndex = 0;
        async function worker(): Promise<void> {
          while (nextIndex < config.probes.length) {
            const index = nextIndex++;
            const probe = config.probes[index];
            if (!probe) continue;
            const runtimeProbe =
              "imageDigestJsonPath" in probe && probe.imageDigestJsonPath
                ? {
                    ...probe,
                    expectedJson: {
                      path: probe.imageDigestJsonPath,
                      value: expectedImageDigest ?? "",
                    },
                  }
                : probe;
            results[index] = await verifyHttpProbe(
              runtimeProbe,
              options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
            );
          }
        }
        await Promise.all(
          Array.from(
            { length: Math.min(probeConcurrency, config.probes.length) },
            () => worker(),
          ),
        );
        return results;
      })()
    : skippedRuntimeChecks(
        config,
        "Runtime probes were not run because provider deployment evidence did not pass.",
      );

  const checks = [
    ...providerChecks,
    ...(expectedImageDigest
      ? [
          evaluateImageDigestEvidence({
            provider: config.provider,
            expectedDigest: expectedImageDigest,
            supported: false,
            observedAt: new Date().toISOString(),
            startedAt: Date.now(),
          }),
        ]
      : []),
    ...runtimeChecks,
  ];

  return VerificationReportSchema.parse({
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    expectedSha: options.expectedSha,
    provider: config.provider,
    resourceUuid:
      config.provider === "coolify"
        ? config.coolify.resourceUuid
        : config.vercel.projectId,
    decision: decide(checks),
    capabilities: providerCapabilities(config.provider, providerApiAvailable),
    checks,
  });
}
