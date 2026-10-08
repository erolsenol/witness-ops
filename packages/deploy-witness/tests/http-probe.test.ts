import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { HttpProbeConfig } from "../src/contracts/index.js";
import { verifyHttpProbe } from "../src/probes/http.js";

const baseProbe: HttpProbeConfig = {
  name: "health",
  url: "https://app.example.test/api/version",
  required: true,
  allowLocalHttp: false,
  expectedStatus: 200,
  timeoutMs: 2_000,
};

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const },
];

describe("HTTP runtime probes", () => {
  it("checks status and a JSON deployment marker without returning the response body", async () => {
    const probe: HttpProbeConfig = {
      ...baseProbe,
      expectedJson: { path: "build.commit", value: "deadbeef" },
    };
    const response = Response.json({
      build: { commit: "deadbeef" },
      apiKey: "do-not-report",
    });
    const result = await verifyHttpProbe(probe, {
      fetchImpl: async () => response,
      lookupImpl: publicLookup,
    });
    expect(result.status).toBe("PASS");
    expect(JSON.stringify(result)).not.toContain("do-not-report");
    expect(
      result.evidence.some(
        (item) =>
          item.field === "json:build.commit:matches" && item.observed === true,
      ),
    ).toBe(true);
  });

  it("records the actual runtime digest as normalized evidence", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const result = await verifyHttpProbe(
      {
        ...baseProbe,
        imageDigestJsonPath: "build.imageDigest",
        expectedJson: { path: "build.imageDigest", value: digest },
      },
      {
        fetchImpl: async () =>
          Response.json({ build: { imageDigest: digest.toUpperCase() } }),
        lookupImpl: publicLookup,
      },
    );

    expect(result.status).toBe("PASS");
    expect(result.evidence).toContainEqual({
      source: "http",
      observedAt: expect.any(String),
      field: "imageDigest:build.imageDigest",
      expected: digest,
      observed: digest,
    });
  });

  it.each([
    {
      label: "missing",
      payload: { build: {} },
      failureCode: "RUNTIME_IMAGE_DIGEST_MISSING",
      observed: null,
    },
    {
      label: "malformed",
      payload: { build: { imageDigest: "release-2026-10" } },
      failureCode: "RUNTIME_IMAGE_DIGEST_INVALID",
      observed: null,
    },
    {
      label: "different",
      payload: { build: { imageDigest: `sha256:${"b".repeat(64)}` } },
      failureCode: "RUNTIME_IMAGE_DIGEST_MISMATCH",
      observed: `sha256:${"b".repeat(64)}`,
    },
  ])("classifies a $label runtime image digest marker", async (scenario) => {
    const digest = `sha256:${"a".repeat(64)}`;
    const result = await verifyHttpProbe(
      {
        ...baseProbe,
        imageDigestJsonPath: "build.imageDigest",
        expectedJson: { path: "build.imageDigest", value: digest },
      },
      {
        fetchImpl: async () => Response.json(scenario.payload),
        lookupImpl: publicLookup,
      },
    );

    expect(result.status).toBe("FAIL");
    expect(result.failureCode).toBe(scenario.failureCode);
    expect(result.evidence).toContainEqual({
      source: "http",
      observedAt: expect.any(String),
      field: "imageDigest:build.imageDigest",
      expected: digest,
      observed: scenario.observed,
    });
  });

  it("does not follow redirects", async () => {
    const result = await verifyHttpProbe(baseProbe, {
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test" },
        }),
      lookupImpl: publicLookup,
    });
    expect(result.status).toBe("FAIL");
    expect(result.failureCode).toBe("HTTP_REDIRECT_BLOCKED");
  });

  it("requires HTTPS except for local development endpoints", async () => {
    const result = await verifyHttpProbe({
      ...baseProbe,
      url: "http://internal.example.test/health",
    });
    expect(result.status).toBe("FAIL");
    expect(result.failureCode).toBe("HTTP_URL_UNSAFE");
  });

  it("fails when the requested runtime commit marker does not match", async () => {
    const result = await verifyHttpProbe(
      { ...baseProbe, expectedJson: { path: "commit", value: "expected" } },
      {
        fetchImpl: async () => Response.json({ commit: "stale" }),
        lookupImpl: publicLookup,
      },
    );
    expect(result.status).toBe("FAIL");
  });

  it("rejects a hostname if any resolved address is private", async () => {
    let requests = 0;
    const result = await verifyHttpProbe(baseProbe, {
      lookupImpl: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.12", family: 4 },
      ],
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ ok: true });
      },
    });
    expect(result.failureCode).toBe("HTTP_URL_UNSAFE");
    expect(requests).toBe(0);
  });

  it("requires explicit opt-in for localhost HTTP", async () => {
    const result = await verifyHttpProbe(
      { ...baseProbe, url: "http://localhost/health", allowLocalHttp: true },
      {
        lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchImpl: async () => Response.json({ ok: true }),
      },
    );
    expect(result.status).toBe("PASS");
  });

  it("does not treat an empty body as a successful JSON marker check", async () => {
    const result = await verifyHttpProbe(
      { ...baseProbe, expectedJson: { path: "commit", value: "expected" } },
      {
        fetchImpl: async () => new Response(null, { status: 204 }),
        lookupImpl: publicLookup,
      },
    );
    expect(result.status).toBe("FAIL");
    expect(
      result.evidence.some(
        (item) =>
          item.field === "json:commit:matches" && item.observed === false,
      ),
    ).toBe(true);
  });

  it("requires consecutive successful responses when stability is configured", async () => {
    const responses = [
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
      new Response(null, { status: 200 }),
    ];
    let requests = 0;
    const result = await verifyHttpProbe(
      {
        ...baseProbe,
        timeoutMs: 1_000,
        stability: { consecutiveSuccesses: 2, intervalMs: 100 },
      },
      {
        fetchImpl: async () => {
          requests += 1;
          return responses.shift() as Response;
        },
        lookupImpl: publicLookup,
      },
    );

    expect(result.status).toBe("PASS");
    expect(requests).toBe(3);
    expect(
      result.evidence.filter((item) => item.field.endsWith(":status")),
    ).toHaveLength(3);
    expect(result.summary).toContain("2 consecutive checks");
  });

  it("fails when the bounded attempts cannot produce enough consecutive successes", async () => {
    const result = await verifyHttpProbe(
      {
        ...baseProbe,
        timeoutMs: 250,
        stability: { consecutiveSuccesses: 2, intervalMs: 1_000 },
      },
      {
        fetchImpl: async () => new Response(null, { status: 503 }),
        lookupImpl: publicLookup,
      },
    );

    expect(result.status).toBe("FAIL");
    expect(result.failureCode).toBe("HTTP_PROBE_FAILED");
    expect(result.summary).toContain("within 1 attempts");
  });

  it("pins the localhost development request to the validated address", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ commit: "expected" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;

    try {
      const result = await verifyHttpProbe(
        {
          ...baseProbe,
          url: `http://localhost:${address.port}/version`,
          allowLocalHttp: true,
          expectedJson: { path: "commit", value: "expected" },
        },
        {
          lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
        },
      );
      expect(result.status).toBe("PASS");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
