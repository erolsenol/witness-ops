export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

type ResponseFailureCode =
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_READ_FAILED"
  | "REQUEST_TIMEOUT"
  | "INVALID_JSON";

export class ProviderResponseError extends Error {
  constructor(readonly code: ResponseFailureCode) {
    super(code);
    this.name = "ProviderResponseError";
  }
}

export function discardProviderResponse(response: Response): void {
  // Cleanup must not wait on an untrusted stream's cancellation hook.
  void response.body?.cancel().catch(() => {});
}

export async function readProviderJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<unknown> {
  if (signal.aborted) {
    discardProviderResponse(response);
    throw new ProviderResponseError("REQUEST_TIMEOUT");
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    discardProviderResponse(response);
    throw new ProviderResponseError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new ProviderResponseError("INVALID_JSON");

  const reader = response.body.getReader();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ProviderResponseError("REQUEST_TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (value?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(value, { stream });
    } catch {
      throw new ProviderResponseError("INVALID_JSON");
    }
  };
  const parts: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes)
        throw new ProviderResponseError("RESPONSE_TOO_LARGE");
      parts.push(decode(value, true));
    }
    parts.push(decode());
    try {
      return JSON.parse(parts.join("")) as unknown;
    } catch {
      throw new ProviderResponseError("INVALID_JSON");
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ProviderResponseError) throw error;
    throw new ProviderResponseError(
      signal.aborted ? "REQUEST_TIMEOUT" : "RESPONSE_READ_FAILED",
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
