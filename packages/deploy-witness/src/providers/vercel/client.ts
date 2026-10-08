import {
  discardProviderResponse,
  ProviderResponseError,
  readProviderJson,
} from "../response.js";
import {
  type VercelDeploymentDetail,
  VercelDeploymentDetailSchema,
  VercelDeploymentListSchema,
  type VercelDeploymentSummary,
} from "./types.js";

const API_BASE_URL = "https://api.vercel.com";
const DEPLOYMENT_PAGE_SIZE = 20;
const MAX_DEPLOYMENT_PAGES = 5;

export interface VercelDeploymentPages {
  readonly deployments: readonly VercelDeploymentSummary[];
  readonly complete: boolean;
}

export class VercelApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = "VercelApiError";
  }
}

export interface VercelClientOptions {
  readonly projectId: string;
  readonly teamId?: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export class VercelClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VercelClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async getJson(url: URL, timeoutMs: number): Promise<unknown> {
    if (!this.options.token) throw new VercelApiError("VERCEL_TOKEN_MISSING");
    let response: Response;
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(timeoutMs, 15_000)),
    );
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/json",
        },
        signal,
        redirect: "error",
      });
    } catch {
      throw new VercelApiError(
        signal.aborted ? "VERCEL_REQUEST_TIMEOUT" : "VERCEL_NETWORK_ERROR",
      );
    }
    if (!response.ok) discardProviderResponse(response);
    if (response.status === 401)
      throw new VercelApiError("VERCEL_UNAUTHORIZED", 401);
    if (response.status === 403)
      throw new VercelApiError("VERCEL_FORBIDDEN", 403);
    if (response.status === 429)
      throw new VercelApiError("VERCEL_RATE_LIMITED", 429);
    if (response.status >= 500)
      throw new VercelApiError("VERCEL_SERVER_ERROR", response.status);
    if (!response.ok)
      throw new VercelApiError("VERCEL_HTTP_ERROR", response.status);

    let payload: unknown;
    try {
      payload = await readProviderJson(response, signal);
    } catch (error) {
      if (error instanceof VercelApiError) throw error;
      if (error instanceof ProviderResponseError)
        throw new VercelApiError(`VERCEL_${error.code}`);
      throw new VercelApiError("VERCEL_INVALID_JSON");
    }
    return payload;
  }

  async listDeployments(
    target: "production" | "preview",
    timeoutMs: number,
  ): Promise<VercelDeploymentPages> {
    const deadline = Date.now() + timeoutMs;
    const deployments: VercelDeploymentSummary[] = [];
    const cursors = new Set<string>();
    let until: string | undefined;

    for (let page = 0; page < MAX_DEPLOYMENT_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { deployments, complete: false };

      const url = new URL("/v7/deployments", API_BASE_URL);
      url.searchParams.set("projectId", this.options.projectId);
      url.searchParams.set("target", target);
      url.searchParams.set("limit", String(DEPLOYMENT_PAGE_SIZE));
      if (this.options.teamId)
        url.searchParams.set("teamId", this.options.teamId);
      if (until) url.searchParams.set("until", until);

      const payload = VercelDeploymentListSchema.safeParse(
        await this.getJson(url, remainingMs),
      );
      if (!payload.success) throw new VercelApiError("VERCEL_RESPONSE_INVALID");
      deployments.push(...payload.data.deployments);

      const next = payload.data.pagination?.next;
      if (next === undefined || next === null) {
        const complete =
          payload.data.pagination !== undefined ||
          payload.data.deployments.length < DEPLOYMENT_PAGE_SIZE;
        return { deployments, complete };
      }
      until = String(next);
      if (cursors.has(until))
        throw new VercelApiError("VERCEL_CURSOR_REPEATED");
      cursors.add(until);
    }

    return { deployments, complete: false };
  }

  async getDeployment(
    id: string,
    timeoutMs: number,
  ): Promise<VercelDeploymentDetail> {
    const url = new URL(
      `/v13/deployments/${encodeURIComponent(id)}`,
      API_BASE_URL,
    );
    url.searchParams.set("withGitRepoInfo", "true");
    if (this.options.teamId)
      url.searchParams.set("teamId", this.options.teamId);
    const payload = VercelDeploymentDetailSchema.safeParse(
      await this.getJson(url, timeoutMs),
    );
    if (!payload.success) throw new VercelApiError("VERCEL_RESPONSE_INVALID");
    return payload.data;
  }
}
