import type { CheckResult } from "../../contracts/index.js";
import { evaluateDeploymentEvidence } from "../deployment-evidence.js";
import { CoolifyApiError, CoolifyClient } from "./client.js";
import type { CoolifyDeployment } from "./types.js";
import {
  deploymentSha,
  deploymentTimestamp,
  newestDeployment,
} from "./types.js";

export interface VerifyCoolifyOptions {
  readonly baseUrl: string;
  readonly resourceUuid: string;
  readonly token: string;
  readonly expectedSha: string;
  readonly startedAfter?: string;
  readonly timeoutSeconds: number;
  readonly pollIntervalSeconds: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

type NormalizedStatus = "pending" | "success" | "failure" | "unknown";

function normalizeStatus(raw: string | undefined): NormalizedStatus {
  switch (raw?.trim().toLowerCase()) {
    case "queued":
    case "in_progress":
    case "building":
    case "processing":
      return "pending";
    case "finished":
    case "successful":
    case "succeeded":
      return "success";
    case "failed":
    case "cancelled":
    case "canceled":
      return "failure";
    default:
      return "unknown";
  }
}

function check(
  id: string,
  status: CheckResult["status"],
  summary: string,
  evidence: CheckResult["evidence"],
  failureCode?: string,
  required = true,
): CheckResult {
  return {
    id,
    category: id.startsWith("provider.") ? "provider" : "deployment",
    required,
    status,
    summary,
    durationMs: 0,
    evidence,
    ...(failureCode ? { failureCode } : {}),
  };
}

function deploymentChecks(
  deployment: CoolifyDeployment | undefined,
  expectedSha: string,
  observedAt: string,
  noDeploymentExpired: boolean,
  unorderableDeploymentFound: boolean,
  minimumCreatedAt?: number,
): readonly CheckResult[] {
  if (!deployment) {
    const summary = unorderableDeploymentFound
      ? "Coolify returned records that could not be ordered confidently because a creation timestamp is missing or newest timestamps are tied."
      : noDeploymentExpired
        ? "No Coolify deployment was found before the verification deadline."
        : "Waiting for a Coolify deployment record.";
    const failureCode = unorderableDeploymentFound
      ? "DEPLOYMENT_ORDER_UNCERTAIN"
      : "DEPLOYMENT_NOT_FOUND";
    return [
      check("deployment.status", "UNKNOWN", summary, [], failureCode),
      check(
        "deployment.commit",
        "UNKNOWN",
        "No deployment commit is available to compare.",
        [],
        unorderableDeploymentFound
          ? "DEPLOYMENT_ORDER_UNCERTAIN"
          : "DEPLOYMENT_COMMIT_MISSING",
      ),
    ];
  }

  const rawStatus = deployment.status;
  const sha = deploymentSha(deployment);
  const createdAt = deploymentTimestamp(deployment);
  return evaluateDeploymentEvidence({
    deployment: {
      provider: "coolify",
      status: normalizeStatus(rawStatus),
      ...(rawStatus !== undefined ? { rawStatus } : {}),
      statusField: "status",
      ...(sha !== undefined ? { commitSha: sha } : {}),
      commitField: deployment.git_commit_sha ? "git_commit_sha" : "commit",
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      createdAtField: "created_at",
      pendingStatusCode: "DEPLOYMENT_PENDING",
      unknownStatusCode: "DEPLOYMENT_STATUS_UNKNOWN",
    },
    expectedSha,
    ...(minimumCreatedAt !== undefined
      ? { startedAfter: new Date(minimumCreatedAt).toISOString() }
      : {}),
    observedAt,
    startedAt: Date.parse(observedAt),
  });
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const MAX_API_ATTEMPTS = 1800;
const MAX_BACKOFF_MS = 30_000;

function transientBackoffMs(failures: number, random: () => number): number {
  const ceiling = Math.min(
    1_000 * 2 ** Math.min(failures - 1, 30),
    MAX_BACKOFF_MS,
  );
  return Math.floor(ceiling * (0.5 + random() * 0.5));
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof CoolifyApiError &&
    (error.code === "COOLIFY_NETWORK_ERROR" ||
      error.code === "COOLIFY_RATE_LIMITED" ||
      error.code === "COOLIFY_REQUEST_TIMEOUT" ||
      (error.code === "COOLIFY_HTTP_ERROR" &&
        error.status !== undefined &&
        error.status >= 500))
  );
}

function providerFailure(
  error: unknown,
  observedAt: string,
): readonly CheckResult[] {
  const code =
    error instanceof CoolifyApiError ? error.code : "COOLIFY_REQUEST_FAILED";
  const status =
    code === "COOLIFY_UNAUTHORIZED" || code === "COOLIFY_FORBIDDEN"
      ? "FAIL"
      : code === "COOLIFY_TOKEN_MISSING" ||
          code === "COOLIFY_URL_INVALID" ||
          code === "COOLIFY_HTTPS_REQUIRED"
        ? "FAIL"
        : "UNKNOWN";
  const summary =
    status === "FAIL"
      ? "Coolify configuration or read-only authentication was rejected. Check the URL, resource UUID, and token permissions."
      : "Coolify could not provide a reliable deployment response before the deadline.";

  return [
    check(
      "provider.coolify-api",
      status,
      summary,
      [{ source: "coolify", observedAt, field: "errorCode", observed: code }],
      code,
    ),
    check(
      "deployment.status",
      "UNKNOWN",
      "Deployment state could not be verified.",
      [],
      "DEPLOYMENT_UNVERIFIED",
    ),
    check(
      "deployment.commit",
      "UNKNOWN",
      "Deployment commit could not be verified.",
      [],
      "DEPLOYMENT_UNVERIFIED",
    ),
  ];
}

export async function verifyCoolifyDeployment(
  options: VerifyCoolifyOptions,
): Promise<readonly CheckResult[]> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const minimumCreatedAt =
    options.startedAfter === undefined
      ? undefined
      : Date.parse(options.startedAfter);
  if (minimumCreatedAt !== undefined && !Number.isFinite(minimumCreatedAt)) {
    return [
      check(
        "deployment.freshness",
        "FAIL",
        "The supplied run-start boundary is not a valid timestamp.",
        [],
        "DEPLOYMENT_STARTED_AFTER_INVALID",
      ),
    ];
  }
  const deadline = now() + options.timeoutSeconds * 1000;
  let client: CoolifyClient;

  try {
    client = new CoolifyClient({
      baseUrl: options.baseUrl,
      resourceUuid: options.resourceUuid,
      token: options.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    return providerFailure(error, new Date(now()).toISOString());
  }

  let lastDeployment: CoolifyDeployment | undefined;
  let unorderableDeploymentFound = false;
  let apiObservedAt: string | undefined;
  let lastError: unknown;
  let attempts = 0;
  let consecutiveTransientFailures = 0;

  while (now() < deadline && attempts < MAX_API_ATTEMPTS) {
    const remainingBeforeRequest = deadline - now();
    if (remainingBeforeRequest <= 0) break;
    attempts += 1;
    try {
      const pageResult = await client.listRecentApplicationDeployments(
        remainingBeforeRequest,
        now,
      );
      apiObservedAt = new Date(now()).toISOString();
      if (!pageResult.complete) {
        return [
          check(
            "provider.coolify-api",
            "PASS",
            "Coolify deployment API responded successfully.",
            [
              {
                source: "coolify",
                observedAt: apiObservedAt,
                field: "resourceUuid",
                observed: options.resourceUuid,
              },
            ],
          ),
          ...deploymentChecks(
            undefined,
            options.expectedSha,
            apiObservedAt,
            true,
            true,
            minimumCreatedAt,
          ),
        ];
      }
      lastDeployment = newestDeployment(pageResult.deployments);
      unorderableDeploymentFound =
        pageResult.deployments.length > 0 && !lastDeployment;
      lastError = undefined;
      consecutiveTransientFailures = 0;

      if (unorderableDeploymentFound) break;

      if (lastDeployment) {
        const status = normalizeStatus(lastDeployment.status);
        if (
          status === "success" ||
          status === "failure" ||
          status === "unknown"
        )
          break;
      }
    } catch (error) {
      lastError = error;
      if (!isTransient(error))
        return providerFailure(error, new Date(now()).toISOString());
      consecutiveTransientFailures += 1;
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    const requestedDelay =
      lastError instanceof CoolifyApiError &&
      lastError.retryAfterMs !== undefined
        ? lastError.retryAfterMs
        : consecutiveTransientFailures > 0
          ? transientBackoffMs(consecutiveTransientFailures, random)
          : options.pollIntervalSeconds * 1000;
    await sleep(Math.min(requestedDelay, remaining));
  }

  if (lastError && !apiObservedAt)
    return providerFailure(lastError, new Date(now()).toISOString());

  const observedAt = apiObservedAt ?? new Date(now()).toISOString();
  const providerCheck = check(
    "provider.coolify-api",
    apiObservedAt ? "PASS" : "UNKNOWN",
    apiObservedAt
      ? "Coolify deployment API responded successfully."
      : "No reliable response was received from Coolify.",
    apiObservedAt
      ? [
          {
            source: "coolify",
            observedAt,
            field: "resourceUuid",
            observed: options.resourceUuid,
          },
        ]
      : [],
    apiObservedAt ? undefined : "COOLIFY_NO_RESPONSE",
  );
  return [
    providerCheck,
    ...deploymentChecks(
      lastDeployment,
      options.expectedSha,
      observedAt,
      now() >= deadline,
      unorderableDeploymentFound,
      minimumCreatedAt,
    ),
  ];
}

export { normalizeStatus as normalizeCoolifyStatus };
