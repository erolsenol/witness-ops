import type { CheckResult } from "../contracts/index.js";

export type NormalizedDeploymentStatus =
  | "pending"
  | "success"
  | "failure"
  | "unknown";

export interface NormalizedDeploymentEvidence {
  readonly provider: "coolify" | "vercel";
  readonly status: NormalizedDeploymentStatus;
  readonly rawStatus?: string;
  readonly statusField: string;
  readonly commitSha?: string;
  readonly commitField: string;
  readonly createdAt?: number;
  readonly createdAtField: string;
  readonly target?: {
    readonly expected: string;
    readonly observed: string;
  };
  readonly failureStatusCode?: string;
  readonly pendingStatusCode?: string;
  readonly unknownStatusCode?: string;
}

export interface EvaluateDeploymentEvidenceOptions {
  readonly deployment: NormalizedDeploymentEvidence;
  readonly expectedSha: string;
  readonly startedAfter?: string;
  readonly observedAt: string;
  readonly startedAt: number;
}

export interface EvaluateImageDigestOptions {
  readonly provider: "coolify" | "vercel";
  readonly expectedDigest: string;
  readonly observedDigest?: string;
  readonly supported: boolean;
  readonly observedAt: string;
  readonly startedAt: number;
}

function check(
  id: string,
  status: CheckResult["status"],
  summary: string,
  _observedAt: string,
  startedAt: number,
  evidence: CheckResult["evidence"],
  failureCode?: string,
  required = true,
): CheckResult {
  return {
    id,
    category: "deployment",
    required,
    status,
    summary,
    durationMs: Math.max(0, Date.now() - startedAt),
    evidence,
    ...(failureCode ? { failureCode } : {}),
  };
}

export function evaluateDeploymentEvidence(
  options: EvaluateDeploymentEvidenceOptions,
): readonly CheckResult[] {
  const { deployment, expectedSha, startedAfter, observedAt, startedAt } =
    options;
  const providerName = deployment.provider === "coolify" ? "Coolify" : "Vercel";
  const status = deployment.target ? "failure" : deployment.status;
  const targetMismatch = deployment.target !== undefined;
  const statusEvidence = deployment.rawStatus
    ? [
        {
          source: deployment.provider,
          observedAt,
          field: deployment.statusField,
          observed: deployment.rawStatus,
        },
      ]
    : [];
  const statusCheck =
    status === "success"
      ? check(
          "deployment.status",
          "PASS",
          `${providerName} reports a successful terminal deployment.`,
          observedAt,
          startedAt,
          statusEvidence,
        )
      : status === "failure"
        ? check(
            "deployment.status",
            "FAIL",
            targetMismatch
              ? `${providerName} deployment target does not match the configured target.`
              : `${providerName} reports a failed or cancelled deployment.`,
            observedAt,
            startedAt,
            targetMismatch
              ? [
                  {
                    source: deployment.provider,
                    observedAt,
                    field: "target",
                    expected: deployment.target?.expected ?? null,
                    observed: deployment.target?.observed ?? null,
                  },
                ]
              : statusEvidence,
            targetMismatch
              ? "VERCEL_TARGET_MISMATCH"
              : (deployment.failureStatusCode ?? "DEPLOYMENT_FAILED"),
          )
        : check(
            "deployment.status",
            "UNKNOWN",
            status === "pending"
              ? `${providerName} deployment is still in progress.`
              : `${providerName} returned a deployment status DeployWitness does not recognize.`,
            observedAt,
            startedAt,
            statusEvidence,
            status === "pending"
              ? (deployment.pendingStatusCode ?? "DEPLOYMENT_PENDING")
              : (deployment.unknownStatusCode ??
                  `${deployment.provider.toUpperCase()}_STATE_UNKNOWN`),
          );

  const sha = deployment.commitSha;
  const commitEvidence = sha
    ? [
        {
          source: deployment.provider,
          observedAt,
          field: deployment.commitField,
          expected: expectedSha,
          observed: sha,
        },
      ]
    : [];
  const commitCheck = !sha
    ? check(
        "deployment.commit",
        "UNKNOWN",
        `${providerName} did not provide a deployment commit SHA.`,
        observedAt,
        startedAt,
        [],
        "DEPLOYMENT_COMMIT_MISSING",
      )
    : sha.toLowerCase() === expectedSha.toLowerCase()
      ? check(
          "deployment.commit",
          "PASS",
          `${providerName} deployment commit matches the expected full SHA.`,
          observedAt,
          startedAt,
          commitEvidence,
        )
      : check(
          "deployment.commit",
          "FAIL",
          `${providerName} deployment commit does not match the expected SHA.`,
          observedAt,
          startedAt,
          commitEvidence,
          "DEPLOYMENT_SHA_MISMATCH",
        );

  const freshnessCheck =
    startedAfter === undefined
      ? check(
          "deployment.freshness",
          "WARN",
          "No run-start boundary was supplied; this deployment cannot be correlated to the current CI run.",
          observedAt,
          startedAt,
          [
            {
              source: deployment.provider,
              observedAt,
              field: deployment.createdAtField,
              observed: deployment.createdAt ?? null,
            },
          ],
          "DEPLOYMENT_RUN_CORRELATION_UNAVAILABLE",
          false,
        )
      : deployment.createdAt === undefined
        ? check(
            "deployment.freshness",
            "UNKNOWN",
            `${providerName} did not provide a usable deployment creation timestamp.`,
            observedAt,
            startedAt,
            [],
            "DEPLOYMENT_ORDER_UNCERTAIN",
          )
        : deployment.createdAt <= Date.parse(startedAfter)
          ? check(
              "deployment.freshness",
              "FAIL",
              `${providerName} deployment was not created strictly after the supplied run-start boundary.`,
              observedAt,
              startedAt,
              [
                {
                  source: deployment.provider,
                  observedAt,
                  field: deployment.createdAtField,
                  expected: Date.parse(startedAfter),
                  observed: deployment.createdAt,
                },
              ],
              "DEPLOYMENT_STALE",
            )
          : check(
              "deployment.freshness",
              "PASS",
              `${providerName} deployment was created after the supplied run-start boundary.`,
              observedAt,
              startedAt,
              [
                {
                  source: deployment.provider,
                  observedAt,
                  field: deployment.createdAtField,
                  expected: Date.parse(startedAfter),
                  observed: deployment.createdAt,
                },
              ],
            );

  return [statusCheck, commitCheck, freshnessCheck];
}

export function evaluateImageDigestEvidence(
  options: EvaluateImageDigestOptions,
): CheckResult {
  const providerName = options.provider === "coolify" ? "Coolify" : "Vercel";
  const digestPattern = /^sha256:[a-f0-9]{64}$/i;
  const observed = options.observedDigest?.toLowerCase();
  const validExpected = digestPattern.test(options.expectedDigest);
  const validObserved = observed === undefined || digestPattern.test(observed);
  const status: CheckResult["status"] = !options.supported
    ? "UNSUPPORTED"
    : !validExpected || !validObserved || observed === undefined
      ? "UNKNOWN"
      : observed === options.expectedDigest.toLowerCase()
        ? "PASS"
        : "FAIL";
  const failureCode =
    status === "UNSUPPORTED"
      ? "DEPLOYMENT_IMAGE_DIGEST_UNSUPPORTED"
      : status === "UNKNOWN"
        ? !validExpected
          ? "EXPECTED_IMAGE_DIGEST_INVALID"
          : !validObserved
            ? "DEPLOYMENT_IMAGE_DIGEST_INVALID"
            : "DEPLOYMENT_IMAGE_DIGEST_MISSING"
        : status === "FAIL"
          ? "DEPLOYMENT_IMAGE_DIGEST_MISMATCH"
          : undefined;
  const summary =
    status === "PASS"
      ? `${providerName} deployment image digest matches the expected immutable digest.`
      : status === "FAIL"
        ? `${providerName} deployment image digest does not match the expected digest.`
        : status === "UNSUPPORTED"
          ? `${providerName} does not expose an immutable image digest for this deployment through the verified read-only API fields.`
          : observed === undefined
            ? `${providerName} did not provide an observed image digest.`
            : `${providerName} returned an invalid image digest value.`;

  return check(
    "deployment.image-digest",
    status,
    summary,
    options.observedAt,
    options.startedAt,
    [
      {
        source: options.provider,
        observedAt: options.observedAt,
        field: "imageDigest",
        expected: options.expectedDigest.toLowerCase(),
        observed: validObserved ? (observed ?? null) : null,
      },
    ],
    failureCode,
  );
}
