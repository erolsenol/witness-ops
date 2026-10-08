import { describe, expect, it, vi } from "vitest";
import {
  type CoolifyApiError,
  CoolifyClient,
  parseRetryAfter,
} from "../src/providers/coolify/client.js";
import {
  normalizeCoolifyStatus,
  verifyCoolifyDeployment,
} from "../src/providers/coolify/verify.js";

const sha = "0123456789abcdef0123456789abcdef01234567";

function deployment(
  status: string,
  commit = sha,
  createdAt = "2026-09-30T09:00:00Z",
) {
  return {
    deployment_uuid: "deployment-1",
    status,
    commit,
    created_at: createdAt,
  };
}

describe("Coolify API client", () => {
  it("parses Retry-After delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("2", 1_000)).toBe(2_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 1_000)).toBe(2_000);
    expect(parseRetryAfter("invalid", 1_000)).toBeUndefined();
  });

  it("requests application deployments with a read-only bearer GET", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([]));
    const client = new CoolifyClient({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "read-only-token",
      fetchImpl,
    });

    await client.listApplicationDeployments();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://coolify.example.test/api/v1/deployments/applications/resource-1?skip=0&take=20",
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer read-only-token",
    );
    expect(init?.redirect).toBe("error");
  });

  it("uses the configured application identity and explicit page bounds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([]));
    const client = new CoolifyClient({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "application/with-slash",
      token: "read-only-token",
      fetchImpl,
    });

    await client.listApplicationDeployments(40, 10);

    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://coolify.example.test/api/v1/deployments/applications/application%2Fwith-slash?skip=40&take=10",
    );
  });

  it("collects complete bounded pages and stops on the short final page", async () => {
    const offsets: string[] = [];
    const client = new CoolifyClient({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "read-only-token",
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        offsets.push(url.searchParams.get("skip") ?? "");
        const skip = Number(url.searchParams.get("skip"));
        const page = Array.from({ length: skip === 0 ? 20 : 2 }, (_, index) =>
          deployment(
            "finished",
            sha,
            new Date(Date.UTC(2026, 8, 30, 9, index + skip)).toISOString(),
          ),
        );
        return Response.json(page);
      },
    });

    const result = await client.listRecentApplicationDeployments(10_000);

    expect(offsets).toEqual(["0", "20"]);
    expect(result.deployments).toHaveLength(22);
    expect(result.complete).toBe(true);
  });

  it("rejects insecure non-local provider URLs", () => {
    expect(
      () =>
        new CoolifyClient({
          baseUrl: "http://coolify.example.test",
          resourceUuid: "r",
          token: "t",
        }),
    ).toThrowError("COOLIFY_HTTPS_REQUIRED");
  });

  it("does not echo provider response bodies in errors", async () => {
    const client = new CoolifyClient({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "secret-token",
      fetchImpl: async () => new Response("private response", { status: 403 }),
    });
    await expect(client.listApplicationDeployments()).rejects.toMatchObject({
      code: "COOLIFY_FORBIDDEN",
      message: "COOLIFY_FORBIDDEN",
    } satisfies Partial<CoolifyApiError>);
  });
});

describe("Coolify deployment verification", () => {
  it("normalizes only known lifecycle values", () => {
    expect(normalizeCoolifyStatus("finished")).toBe("success");
    expect(normalizeCoolifyStatus("queued")).toBe("pending");
    expect(normalizeCoolifyStatus("mystery-state")).toBe("unknown");
  });

  it("checks the newest deployment SHA, not an older successful record", async () => {
    const fetchImpl = async () =>
      Response.json([
        deployment("finished", sha, "2026-09-29T09:00:00Z"),
        deployment(
          "finished",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "2026-09-30T09:00:00Z",
        ),
      ]);

    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl,
    });

    expect(checks.find((item) => item.id === "deployment.status")?.status).toBe(
      "PASS",
    );
    expect(checks.find((item) => item.id === "deployment.commit")?.status).toBe(
      "FAIL",
    );
  });

  it("fails when the latest deployment predates the supplied run boundary", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      startedAfter: "2026-09-30T10:00:00Z",
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () => Response.json([deployment("finished")]),
    });
    expect(
      checks.find((item) => item.id === "deployment.freshness"),
    ).toMatchObject({
      required: true,
      status: "FAIL",
      failureCode: "DEPLOYMENT_STALE",
    });
  });

  it("fails when deployment creation exactly matches the run boundary", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      startedAfter: "2026-09-30T09:00:00Z",
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () =>
        Response.json([deployment("finished", sha, "2026-09-30T09:00:00Z")]),
    });

    expect(
      checks.find((item) => item.id === "deployment.freshness"),
    ).toMatchObject({
      required: true,
      status: "FAIL",
      failureCode: "DEPLOYMENT_STALE",
    });
  });

  it("passes freshness when the deployment follows the supplied run boundary", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      startedAfter: "2026-09-30T08:00:00Z",
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () => Response.json([deployment("finished")]),
    });
    expect(
      checks.find((item) => item.id === "deployment.freshness"),
    ).toMatchObject({
      required: true,
      status: "PASS",
    });
  });

  it("warns without failing when the caller provides no run boundary", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () => Response.json([deployment("finished")]),
    });
    expect(
      checks.find((item) => item.id === "deployment.freshness"),
    ).toMatchObject({
      required: false,
      status: "WARN",
      failureCode: "DEPLOYMENT_RUN_CORRELATION_UNAVAILABLE",
    });
  });

  it("fails closed when deployment records lack a valid creation timestamp", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () =>
        Response.json([{ status: "finished", commit: sha }]),
    });
    expect(
      checks.find((item) => item.id === "deployment.status"),
    ).toMatchObject({
      status: "UNKNOWN",
      failureCode: "DEPLOYMENT_ORDER_UNCERTAIN",
    });
    expect(checks.find((item) => item.id === "deployment.commit")?.status).toBe(
      "UNKNOWN",
    );
  });

  it("fails closed when newest deployment timestamps are tied", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () =>
        Response.json([
          deployment("finished", sha, "2026-09-30T09:00:00Z"),
          deployment("finished", "b".repeat(40), "2026-09-30T09:00:00Z"),
        ]),
    });
    expect(
      checks.find((item) => item.id === "deployment.status"),
    ).toMatchObject({
      status: "UNKNOWN",
      failureCode: "DEPLOYMENT_ORDER_UNCERTAIN",
    });
  });

  it("fails closed when the bounded deployment history is still full", async () => {
    let calls = 0;
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () => {
        calls += 1;
        return Response.json(
          Array.from({ length: 20 }, (_, index) =>
            deployment(
              "finished",
              sha,
              new Date(Date.UTC(2026, 8, 30, 9, calls, index)).toISOString(),
            ),
          ),
        );
      },
    });

    expect(calls).toBe(5);
    expect(
      checks.find((item) => item.id === "deployment.status"),
    ).toMatchObject({
      status: "UNKNOWN",
      failureCode: "DEPLOYMENT_ORDER_UNCERTAIN",
    });
  });

  it("rejects an invalid run-start boundary without calling Coolify", async () => {
    let calls = 0;
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      startedAfter: "not-a-timestamp",
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () => {
        calls += 1;
        return Response.json([deployment("finished")]);
      },
    });
    expect(calls).toBe(0);
    expect(checks[0]?.failureCode).toBe("DEPLOYMENT_STARTED_AFTER_INVALID");
  });

  it("fails closed on unknown provider statuses", async () => {
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 30,
      pollIntervalSeconds: 1,
      fetchImpl: async () =>
        Response.json([deployment("finished-but-not-documented")]),
    });
    expect(checks.find((item) => item.id === "deployment.status")?.status).toBe(
      "UNKNOWN",
    );
  });

  it("waits for a queued deployment and then verifies its terminal result", async () => {
    let now = 0;
    let calls = 0;
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 10,
      pollIntervalSeconds: 1,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      fetchImpl: async () => {
        calls += 1;
        return Response.json([deployment(calls === 1 ? "queued" : "finished")]);
      },
    });
    expect(calls).toBe(2);
    expect(
      checks
        .filter((item) => item.required)
        .every((item) => item.status === "PASS"),
    ).toBe(true);
  });

  it("honors a 429 Retry-After value within the global deadline", async () => {
    let now = 0;
    let calls = 0;
    const delays: number[] = [];
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 10,
      pollIntervalSeconds: 1,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("", {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }
        return Response.json([deployment("finished")]);
      },
    });
    expect(delays).toEqual([2_000]);
    expect(calls).toBe(2);
    expect(
      checks
        .filter((item) => item.required)
        .every((item) => item.status === "PASS"),
    ).toBe(true);
  });

  it("retries 5xx with bounded exponential backoff and jitter", async () => {
    let now = 0;
    let calls = 0;
    const delays: number[] = [];
    await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 10,
      pollIntervalSeconds: 1,
      now: () => now,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 503 })
          : Response.json([deployment("finished")]);
      },
    });
    expect(delays).toEqual([750]);
    expect(calls).toBe(2);
  });

  it("does not retry non-transient 4xx responses", async () => {
    let calls = 0;
    const checks = await verifyCoolifyDeployment({
      baseUrl: "https://coolify.example.test",
      resourceUuid: "resource-1",
      token: "token",
      expectedSha: sha,
      timeoutSeconds: 10,
      pollIntervalSeconds: 1,
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 404 });
      },
    });
    expect(calls).toBe(1);
    expect(checks[0]?.failureCode).toBe("COOLIFY_HTTP_ERROR");
  });
});
