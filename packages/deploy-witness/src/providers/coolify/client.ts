import {
  discardProviderResponse,
  ProviderResponseError,
  readProviderJson,
} from "../response.js";
import type { CoolifyDeployment } from "./types.js";
import { CoolifyDeploymentListSchema } from "./types.js";

export class CoolifyApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, status?: number, retryAfterMs?: number) {
    super(code);
    this.name = "CoolifyApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMs);
}

export interface CoolifyClientOptions {
  readonly baseUrl: string;
  readonly resourceUuid: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface CoolifyDeploymentPages {
  readonly deployments: readonly CoolifyDeployment[];
  readonly complete: boolean;
}

export const DEPLOYMENT_PAGE_SIZE = 20;
export const MAX_DEPLOYMENT_PAGES = 5;

function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoolifyApiError("COOLIFY_URL_INVALID");
  }

  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CoolifyApiError("COOLIFY_HTTPS_REQUIRED");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CoolifyApiError("COOLIFY_URL_INVALID");
  }
  return url;
}

export class CoolifyClient {
  readonly #baseUrl: URL;
  readonly #resourceUuid: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CoolifyClientOptions) {
    if (!options.token.trim())
      throw new CoolifyApiError("COOLIFY_TOKEN_MISSING");
    this.#baseUrl = parseBaseUrl(options.baseUrl);
    this.#resourceUuid = options.resourceUuid;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async listApplicationDeployments(
    skip = 0,
    take = 20,
    requestTimeoutMs = this.#timeoutMs,
  ): Promise<readonly CoolifyDeployment[]> {
    const url = new URL(this.#baseUrl);
    const prefix = url.pathname.replace(/\/$/, "");
    url.pathname = `${prefix}/api/v1/deployments/applications/${encodeURIComponent(this.#resourceUuid)}`;
    url.searchParams.set("skip", String(skip));
    url.searchParams.set("take", String(take));

    let response: Response;
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(requestTimeoutMs, this.#timeoutMs)),
    );
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
        },
        signal,
        redirect: "error",
      });
    } catch {
      throw new CoolifyApiError(
        signal.aborted ? "COOLIFY_REQUEST_TIMEOUT" : "COOLIFY_NETWORK_ERROR",
      );
    }

    if (!response.ok) discardProviderResponse(response);
    if (response.status === 401)
      throw new CoolifyApiError("COOLIFY_UNAUTHORIZED", 401);
    if (response.status === 403)
      throw new CoolifyApiError("COOLIFY_FORBIDDEN", 403);
    if (response.status === 429)
      throw new CoolifyApiError(
        "COOLIFY_RATE_LIMITED",
        429,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    if (response.status === 408)
      throw new CoolifyApiError("COOLIFY_REQUEST_TIMEOUT", 408);
    if (!response.ok)
      throw new CoolifyApiError(
        "COOLIFY_HTTP_ERROR",
        response.status,
        response.status >= 500
          ? parseRetryAfter(response.headers.get("retry-after"))
          : undefined,
      );

    let body: unknown;
    try {
      body = await readProviderJson(response, signal);
    } catch (error) {
      if (error instanceof ProviderResponseError)
        throw new CoolifyApiError(`COOLIFY_${error.code}`);
      throw new CoolifyApiError("COOLIFY_INVALID_JSON");
    }

    const parsed = CoolifyDeploymentListSchema.safeParse(body);
    if (!parsed.success) throw new CoolifyApiError("COOLIFY_RESPONSE_INVALID");
    return parsed.data;
  }

  async listRecentApplicationDeployments(
    timeoutMs = this.#timeoutMs,
    now: () => number = Date.now,
  ): Promise<CoolifyDeploymentPages> {
    const deadline = now() + timeoutMs;
    const deployments: CoolifyDeployment[] = [];

    for (let page = 0; page < MAX_DEPLOYMENT_PAGES; page += 1) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) return { deployments, complete: false };
      const records = await this.listApplicationDeployments(
        page * DEPLOYMENT_PAGE_SIZE,
        DEPLOYMENT_PAGE_SIZE,
        remainingMs,
      );
      deployments.push(...records);
      if (records.length < DEPLOYMENT_PAGE_SIZE)
        return { deployments, complete: true };
    }

    return { deployments, complete: false };
  }
}
