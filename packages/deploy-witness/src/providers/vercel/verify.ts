import type { CheckResult, VerificationConfig } from "../../contracts/index.js";
import { evaluateDeploymentEvidence } from "../deployment-evidence.js";
import { VercelApiError, VercelClient } from "./client.js";
import {
  type VercelDeploymentDetail,
  type VercelDeploymentSummary,
  vercelTimestamp,
} from "./types.js";

type VercelConfig = Extract<VerificationConfig, { provider: "vercel" }>;

export interface VerifyVercelOptions {
  readonly config: VercelConfig;
  readonly token: string;
  readonly expectedSha: string;
  readonly startedAfter?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function result(
  id: string,
  status: CheckResult["status"],
  summary: string,
  _observedAt: string,
  startedAt: number,
  evidence: CheckResult["evidence"] = [],
  failureCode?: string,
  required = true,
): CheckResult {
  return {
    id,
    category: id.startsWith("provider.") ? "provider" : "deployment",
    required,
    status,
    summary,
    durationMs: Math.max(0, Date.now() - startedAt),
    evidence,
    ...(failureCode ? { failureCode } : {}),
  };
}

function evidence(
  observedAt: string,
  field: string,
  expected?: string | number | null,
  observed?: string | number | null,
): CheckResult["evidence"] {
  return [
    {
      source: "vercel",
      observedAt,
      field,
      ...(expected !== undefined ? { expected } : {}),
      ...(observed !== undefined ? { observed } : {}),
    },
  ];
}

function apiFailure(error: unknown): {
  readonly code: string;
  readonly summary: string;
} {
  if (!(error instanceof VercelApiError))
    return {
      code: "VERCEL_REQUEST_FAILED",
      summary: "The Vercel API request failed safely.",
    };
  const descriptions: Record<string, string> = {
    VERCEL_TOKEN_MISSING: "Set VERCEL_TOKEN to read deployment information.",
    VERCEL_UNAUTHORIZED: "Vercel rejected the access token.",
    VERCEL_FORBIDDEN: "The Vercel token cannot access this project.",
    VERCEL_RATE_LIMITED: "Vercel rate limited the deployment request.",
    VERCEL_NETWORK_ERROR: "Vercel could not be reached.",
    VERCEL_RESPONSE_INVALID: "Vercel returned an unexpected response shape.",
    VERCEL_INVALID_JSON: "Vercel returned invalid JSON.",
    VERCEL_RESPONSE_TOO_LARGE: "Vercel response exceeded the safety limit.",
  };
  return {
    code: error.code,
    summary:
      descriptions[error.code] ?? "The Vercel API request did not succeed.",
  };
}

function incompleteDeployment(
  observedAt: string,
  startedAt: number,
  code: string,
  summary: string,
): readonly CheckResult[] {
  return [
    result(
      "provider.vercel-api",
      "PASS",
      "Vercel API responded successfully.",
      observedAt,
      startedAt,
    ),
    result(
      "deployment.status",
      "UNKNOWN",
      summary,
      observedAt,
      startedAt,
      [],
      code,
    ),
    result(
      "deployment.commit",
      "UNKNOWN",
      "No deployment commit is available to compare.",
      observedAt,
      startedAt,
      [],
      code,
    ),
  ];
}

function newestDeployment(deployments: readonly VercelDeploymentSummary[]): {
  deployment?: VercelDeploymentSummary;
  error?: string;
} {
  if (
    deployments.some((deployment) => vercelTimestamp(deployment) === undefined)
  )
    return { error: "DEPLOYMENT_ORDER_UNCERTAIN" };
  const sorted = [...deployments].sort(
    (left, right) =>
      (vercelTimestamp(right) ?? 0) - (vercelTimestamp(left) ?? 0),
  );
  const newest = sorted[0];
  if (!newest) return {};
  if (sorted[1] && vercelTimestamp(sorted[1]) === vercelTimestamp(newest)) {
    return { error: "DEPLOYMENT_ORDER_UNCERTAIN" };
  }
  if (!(newest.uid ?? newest.id)) return { error: "DEPLOYMENT_ID_MISSING" };
  return { deployment: newest };
}

function evaluateDeployment(
  config: VercelConfig,
  deployment: VercelDeploymentDetail,
  expectedSha: string,
  startedAfter: string | undefined,
  observedAt: string,
  startedAt: number,
): readonly CheckResult[] {
  const timestamp = vercelTimestamp(deployment);
  const normalizedTarget = deployment.target ?? "preview";
  const wantedTarget = config.vercel.target;
  const readyState = deployment.readyState;
  const sha = deployment.gitSource?.sha;
  const status =
    readyState === "READY"
      ? "success"
      : readyState === "ERROR" || readyState === "CANCELED"
        ? "failure"
        : ["BUILDING", "INITIALIZING", "QUEUED"].includes(readyState)
          ? "pending"
          : "unknown";
  const targetMismatch = normalizedTarget !== wantedTarget;
  return evaluateDeploymentEvidence({
    deployment: {
      provider: "vercel",
      status,
      rawStatus: readyState,
      statusField: "readyState",
      ...(sha !== undefined ? { commitSha: sha } : {}),
      commitField: "gitSource.sha",
      ...(timestamp !== undefined ? { createdAt: timestamp } : {}),
      createdAtField: "createdAt",
      ...(targetMismatch
        ? { target: { expected: wantedTarget, observed: normalizedTarget } }
        : {}),
      ...(status === "failure"
        ? { failureStatusCode: `VERCEL_${readyState}` }
        : {}),
      pendingStatusCode: "VERCEL_DEPLOYMENT_PENDING",
      unknownStatusCode: "VERCEL_STATE_UNKNOWN",
    },
    expectedSha,
    ...(startedAfter ? { startedAfter } : {}),
    observedAt,
    startedAt,
  });
}

export async function verifyVercelDeployment(
  options: VerifyVercelOptions,
): Promise<readonly CheckResult[]> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const deadline = startedAt + options.config.deployment.timeoutSeconds * 1000;
  const client = new VercelClient({
    projectId: options.config.vercel.projectId,
    ...(options.config.vercel.teamId
      ? { teamId: options.config.vercel.teamId }
      : {}),
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  let lastObservedAt = new Date(startedAt).toISOString();

  while (now() < deadline) {
    const remainingMs = deadline - now();
    try {
      const pageResult = await client.listDeployments(
        options.config.vercel.target,
        remainingMs,
      );
      lastObservedAt = new Date(now()).toISOString();
      if (!pageResult.complete) {
        return incompleteDeployment(
          lastObservedAt,
          startedAt,
          "DEPLOYMENT_PAGINATION_LIMIT",
          "Vercel deployment history exceeded the bounded page or time limit.",
        );
      }
      const deployments = pageResult.deployments;
      if (deployments.length === 0) {
        await sleep(
          Math.min(
            options.config.deployment.pollIntervalSeconds * 1000,
            Math.max(1, deadline - now()),
          ),
        );
        continue;
      }
      const newest = newestDeployment(deployments);
      if (newest.error) {
        return incompleteDeployment(
          lastObservedAt,
          startedAt,
          newest.error,
          "Vercel deployments could not be ordered confidently.",
        );
      }
      const id = newest.deployment?.uid ?? newest.deployment?.id;
      if (!id) {
        return incompleteDeployment(
          lastObservedAt,
          startedAt,
          "DEPLOYMENT_ID_MISSING",
          "Vercel did not return a deployment identifier.",
        );
      }
      const detail = await client.getDeployment(
        id,
        Math.max(1, deadline - now()),
      );
      lastObservedAt = new Date(now()).toISOString();
      if (detail.projectId !== options.config.vercel.projectId) {
        const identityKnown = detail.projectId !== undefined;
        return [
          result(
            "provider.vercel-api",
            "PASS",
            "Vercel API responded successfully.",
            lastObservedAt,
            startedAt,
          ),
          result(
            "deployment.status",
            identityKnown ? "FAIL" : "UNKNOWN",
            identityKnown
              ? "Vercel returned a deployment from a different project."
              : "Vercel did not identify the deployment project.",
            lastObservedAt,
            startedAt,
            evidence(
              lastObservedAt,
              "projectId",
              options.config.vercel.projectId,
              detail.projectId,
            ),
            identityKnown
              ? "VERCEL_PROJECT_MISMATCH"
              : "VERCEL_PROJECT_ID_MISSING",
          ),
          result(
            "deployment.commit",
            "UNKNOWN",
            "A matching project deployment is unavailable.",
            lastObservedAt,
            startedAt,
            [],
            identityKnown
              ? "VERCEL_PROJECT_MISMATCH"
              : "VERCEL_PROJECT_ID_MISSING",
          ),
        ];
      }
      const deploymentChecks = evaluateDeployment(
        options.config,
        detail,
        options.expectedSha,
        options.startedAfter,
        lastObservedAt,
        startedAt,
      );
      const checks = [
        result(
          "provider.vercel-api",
          "PASS",
          "Vercel deployment details were retrieved.",
          lastObservedAt,
          startedAt,
        ),
        ...deploymentChecks,
      ];
      const statusCheck = checks.find(
        (check) => check.id === "deployment.status",
      );
      if (
        statusCheck?.status === "UNKNOWN" &&
        ["VERCEL_STATE_UNKNOWN", "VERCEL_PROJECT_ID_MISSING"].includes(
          statusCheck.failureCode ?? "",
        )
      ) {
        return checks;
      }
      if (statusCheck?.status === "UNKNOWN") {
        await sleep(
          Math.min(
            options.config.deployment.pollIntervalSeconds * 1000,
            Math.max(1, deadline - now()),
          ),
        );
        continue;
      }
      return checks;
    } catch (error) {
      const failure = apiFailure(error);
      return [
        result(
          "provider.vercel-api",
          "FAIL",
          failure.summary,
          lastObservedAt,
          startedAt,
          [],
          failure.code,
        ),
        result(
          "deployment.status",
          "UNKNOWN",
          "Vercel deployment state is unavailable.",
          lastObservedAt,
          startedAt,
          [],
          failure.code,
        ),
        result(
          "deployment.commit",
          "UNKNOWN",
          "Vercel deployment commit is unavailable.",
          lastObservedAt,
          startedAt,
          [],
          failure.code,
        ),
      ];
    }
  }

  return incompleteDeployment(
    lastObservedAt,
    startedAt,
    "VERCEL_DEPLOYMENT_TIMEOUT",
    "No matching Vercel deployment became ready before the verification deadline.",
  );
}
