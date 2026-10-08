import { describe, expect, it, vi } from "vitest";
import { CoolifyClient } from "../src/providers/coolify/client.js";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  readProviderJson,
} from "../src/providers/response.js";
import { VercelClient } from "../src/providers/vercel/client.js";

const encoder = new TextEncoder();

function chunkedResponse(
  chunks: readonly Uint8Array[],
  cancel = vi.fn(),
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
}

describe("bounded provider JSON reader", () => {
  it("accepts an exact byte limit and decodes split UTF-8 characters", async () => {
    const bytes = encoder.encode('{"value":"ş"}');
    const response = chunkedResponse(
      Array.from(bytes, (byte) => new Uint8Array([byte])),
    );
    await expect(
      readProviderJson(
        response,
        new AbortController().signal,
        bytes.byteLength,
      ),
    ).resolves.toEqual({ value: "ş" });
  });

  it("counts bytes rather than decoded string characters", async () => {
    const bytes = encoder.encode('{"value":"ş"}');
    const cancel = vi.fn();
    await expect(
      readProviderJson(
        chunkedResponse([bytes], cancel),
        new AbortController().signal,
        bytes.byteLength - 1,
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects declared oversized responses before reading a chunk", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
      {
        headers: { "content-length": "9" },
      },
    );
    await expect(
      readProviderJson(response, new AbortController().signal, 8),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops a chunked response at the limit even when cancellation never resolves", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = chunkedResponse(
      [
        encoder.encode("12345"),
        encoder.encode("67890"),
        encoder.encode("secret"),
      ],
      cancel,
    );
    await expect(
      readProviderJson(response, new AbortController().signal, 8),
    ).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      message: "RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(["", "not-json-secret", '{"truncated":'])(
    "rejects malformed or truncated JSON without response details",
    async (body) => {
      await expect(
        readProviderJson(new Response(body), new AbortController().signal),
      ).rejects.toMatchObject({
        code: "INVALID_JSON",
        message: "INVALID_JSON",
      });
    },
  );

  it("reports a failed response stream without exposing its error", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("secret-token"));
        },
      }),
    );
    await expect(
      readProviderJson(response, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "RESPONSE_READ_FAILED",
      message: "RESPONSE_READ_FAILED",
    });
  });

  it("cancels a stalled body when the request deadline signal aborts", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
    );
    const controller = new AbortController();
    const reading = readProviderJson(response, controller.signal);
    const assertion = expect(reading).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    controller.abort(new Error("secret-abort-reason"));
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("rejects an already aborted request without reading its body", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
    );
    await expect(
      readProviderJson(response, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe.each(["coolify", "vercel"] as const)(
  "%s response limits",
  (provider) => {
    function request(response: Response, timeoutMs = 1_000): Promise<unknown> {
      return provider === "coolify"
        ? new CoolifyClient({
            baseUrl: "https://coolify.example.test",
            resourceUuid: "app",
            token: "secret-token",
            fetchImpl: async () => response,
          }).listApplicationDeployments(0, 20, timeoutMs)
        : new VercelClient({
            projectId: "prj_app",
            token: "secret-token",
            fetchImpl: async () => response,
          }).listDeployments("production", timeoutMs);
    }

    it("enforces the 2 MiB boundary while streaming", async () => {
      const cancel = vi.fn();
      await expect(
        request(
          chunkedResponse(
            [new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES), new Uint8Array(1)],
            cancel,
          ),
        ),
      ).rejects.toMatchObject({
        code: `${provider.toUpperCase()}_RESPONSE_TOO_LARGE`,
      });
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("maps invalid JSON to a provider-specific safe error", async () => {
      await expect(
        request(new Response("secret-token malformed")),
      ).rejects.toMatchObject({
        code: `${provider.toUpperCase()}_INVALID_JSON`,
        message: `${provider.toUpperCase()}_INVALID_JSON`,
      });
    });

    it("keeps the request deadline active while a response body stalls", async () => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
      );
      await expect(request(response, 25)).rejects.toMatchObject({
        code: `${provider.toUpperCase()}_REQUEST_TIMEOUT`,
      });
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("discards rejected credential bodies without reading them", async () => {
      const pull = vi.fn();
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
        { status: 401 },
      );
      await expect(request(response)).rejects.toMatchObject({
        code: `${provider.toUpperCase()}_UNAUTHORIZED`,
      });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    });
  },
);

describe("provider UTF-8 integrity", () => {
  it.each([[0xff], [0xc3], [0xe2, 0x28, 0xa1]])(
    "rejects invalid bytes %j rather than replacing evidence text",
    async (...bytes) => {
      const response = chunkedResponse([
        encoder.encode('{"value":"'),
        new Uint8Array(bytes),
        encoder.encode('"}'),
      ]);
      await expect(
        readProviderJson(response, new AbortController().signal),
      ).rejects.toMatchObject({ code: "INVALID_JSON" });
      expect(response.body?.locked).toBe(false);
    },
  );
});
