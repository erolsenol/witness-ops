import { describe, expect, it } from "vitest";
import {
  type VerificationConfig,
  VerificationConfigSchema,
} from "../src/contracts/index.js";
import { VercelClient } from "../src/providers/vercel/client.js";
import { verifyVercelDeployment } from "../src/providers/vercel/verify.js";

const expectedSha = "b".repeat(40);

function vercelConfig(
  target: "production" | "preview" = "production",
): Extract<VerificationConfig, { provider: "vercel" }> {
  const config = VerificationConfigSchema.parse({
    version: 1,
    provider: "vercel",
    vercel: { projectId: "prj_demo", teamId: "team_demo", target },
    deployment: { timeoutSeconds: 10, pollIntervalSeconds: 1 },
    probes: [],
  });
  if (config.provider !== "vercel")
    throw new Error("Expected a Vercel configuration.");
  return config;
}

describe("Vercel deployment adapter", () => {
  it("uses read-only scoped API calls and requests Git source details", async () => {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const client = new VercelClient({
      projectId: "prj_demo",
      teamId: "team_demo",
      token: "read-only-token",
      fetchImpl: async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        requests.push({ url, ...(init ? { init } : {}) });
        return url.pathname === "/v7/deployments"
          ? Response.json({
              deployments: [{ uid: "dpl_demo", createdAt: 1_800_000_000_000 }],
            })
          : Response.json({ id: "dpl_demo", readyState: "READY" });
      },
    });

    await client.listDeployments("production", 1_000);
    await client.getDeployment("dpl_demo", 1_000);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.origin).toBe("https://api.vercel.com");
    expect(requests[0]?.url.pathname).toBe("/v7/deployments");
    expect(requests[0]?.url.searchParams.get("projectId")).toBe("prj_demo");
    expect(requests[0]?.url.searchParams.get("teamId")).toBe("team_demo");
    expect(requests[0]?.url.searchParams.get("target")).toBe("production");
    expect(requests[0]?.url.searchParams.get("limit")).toBe("20");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer read-only-token",
    );
    expect(requests[1]?.url.pathname).toBe("/v13/deployments/dpl_demo");
    expect(requests[1]?.url.searchParams.get("withGitRepoInfo")).toBe("true");
  });

  it("follows the Vercel pagination cursor with the until parameter", async () => {
    const requests: URL[] = [];
    const client = new VercelClient({
      projectId: "prj_demo",
      token: "read-only-token",
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        requests.push(url);
        return Response.json({
          deployments: [
            {
              uid: `dpl_${requests.length}`,
              createdAt: 1_800_000_000_000 - requests.length,
            },
          ],
          pagination: {
            next: requests.length === 1 ? 1_700_000_000_000 : null,
          },
        });
      },
    });

    const result = await client.listDeployments("production", 10_000);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.searchParams.get("until")).toBeNull();
    expect(requests[1]?.searchParams.get("until")).toBe("1700000000000");
    expect(result.deployments).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  it("marks history incomplete when the bounded page limit still has a next cursor", async () => {
    const requests: URL[] = [];
    const client = new VercelClient({
      projectId: "prj_demo",
      token: "read-only-token",
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        requests.push(url);
        return Response.json({
          deployments: [
            {
              uid: `dpl_${requests.length}`,
              createdAt: 1_800_000_000_000 - requests.length,
            },
          ],
          pagination: { next: 1_700_000_000_000 - requests.length },
        });
      },
    });

    const result = await client.listDeployments("production", 10_000);

    expect(requests).toHaveLength(5);
    expect(result.complete).toBe(false);
  });

  it("does not verify deployment identity from history beyond the page bound", async () => {
    const requests: URL[] = [];
    const checks = await verifyVercelDeployment({
      config: vercelConfig(),
      token: "read-only-token",
      expectedSha,
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        requests.push(url);
        return Response.json({
          deployments: [
            {
              uid: `dpl_${requests.length}`,
              createdAt: 1_800_000_000_000 - requests.length,
            },
          ],
          pagination: { next: 1_700_000_000_000 - requests.length },
        });
      },
    });

    expect(requests).toHaveLength(5);
    expect(
      checks.find((check) => check.id === "deployment.status"),
    ).toMatchObject({
      status: "UNKNOWN",
      failureCode: "DEPLOYMENT_PAGINATION_LIMIT",
    });
  });

  it("fails closed when Vercel rejects the token", async () => {
    const client = new VercelClient({
      projectId: "prj_demo",
      token: "bad-token",
      fetchImpl: async () =>
        new Response("private response detail", { status: 401 }),
    });

    await expect(
      client.listDeployments("production", 1_000),
    ).rejects.toMatchObject({
      code: "VERCEL_UNAUTHORIZED",
      status: 401,
    });
  });

  it("reports rate limiting without leaking provider response content", async () => {
    const client = new VercelClient({
      projectId: "prj_demo",
      token: "secret-token",
      fetchImpl: async () =>
        new Response("secret-token private response", { status: 429 }),
    });

    await expect(
      client.listDeployments("production", 1_000),
    ).rejects.toMatchObject({
      code: "VERCEL_RATE_LIMITED",
      status: 429,
      message: "VERCEL_RATE_LIMITED",
    });
  });

  it("waits for a building deployment and then confirms the expected commit", async () => {
    let details = 0;
    const now = Date.now();
    const checks = await verifyVercelDeployment({
      config: vercelConfig(),
      token: "read-only-token",
      expectedSha,
      startedAfter: new Date(now - 1_000).toISOString(),
      sleep: async () => {},
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        if (url.pathname === "/v7/deployments")
          return Response.json({
            deployments: [{ uid: "dpl_demo", createdAt: now }],
          });
        details += 1;
        return Response.json({
          id: "dpl_demo",
          projectId: "prj_demo",
          readyState: details === 1 ? "BUILDING" : "READY",
          target: "production",
          createdAt: now,
          gitSource: { sha: expectedSha },
        });
      },
    });

    expect(details).toBe(2);
    expect(
      checks.find((check) => check.id === "deployment.status")?.status,
    ).toBe("PASS");
    expect(
      checks.find((check) => check.id === "deployment.commit")?.status,
    ).toBe("PASS");
  });

  it("does not treat an unknown Vercel deployment state as success", async () => {
    const now = Date.now();
    const checks = await verifyVercelDeployment({
      config: vercelConfig(),
      token: "read-only-token",
      expectedSha,
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        return url.pathname === "/v7/deployments"
          ? Response.json({
              deployments: [{ uid: "dpl_demo", createdAt: now }],
            })
          : Response.json({
              id: "dpl_demo",
              projectId: "prj_demo",
              readyState: "NEW_PROVIDER_STATE",
              target: "production",
              createdAt: now,
              gitSource: { sha: expectedSha },
            });
      },
    });

    expect(
      checks.find((check) => check.id === "deployment.status"),
    ).toMatchObject({
      required: true,
      status: "UNKNOWN",
      failureCode: "VERCEL_STATE_UNKNOWN",
    });
  });

  it("maps Vercel's null deployment target to preview and detects scope drift", async () => {
    const now = Date.now();
    const checks = await verifyVercelDeployment({
      config: vercelConfig("preview"),
      token: "read-only-token",
      expectedSha,
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        return url.pathname === "/v7/deployments"
          ? Response.json({
              deployments: [{ uid: "dpl_demo", createdAt: now }],
            })
          : Response.json({
              id: "dpl_demo",
              projectId: "prj_demo",
              readyState: "READY",
              target: null,
              createdAt: now,
              gitSource: { sha: expectedSha },
            });
      },
    });

    expect(
      checks.find((check) => check.id === "deployment.status")?.status,
    ).toBe("PASS");
  });

  it.each([
    [undefined, "UNKNOWN", "VERCEL_PROJECT_ID_MISSING"],
    ["prj_other", "FAIL", "VERCEL_PROJECT_MISMATCH"],
  ] as const)(
    "rejects deployment project identity %s",
    async (projectId, status, failureCode) => {
      const now = Date.now();
      const checks = await verifyVercelDeployment({
        config: vercelConfig(),
        token: "read-only-token",
        expectedSha,
        fetchImpl: async (input) => {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          return url.pathname === "/v7/deployments"
            ? Response.json({
                deployments: [{ uid: "dpl_demo", createdAt: now }],
              })
            : Response.json({
                id: "dpl_demo",
                ...(projectId ? { projectId } : {}),
                readyState: "READY",
                target: "production",
                gitSource: { sha: expectedSha },
              });
        },
      });

      expect(
        checks.find((check) => check.id === "deployment.status"),
      ).toMatchObject({ status, failureCode });
    },
  );
});
