import { describe, expect, it } from "vitest";
import { VerificationConfigSchema } from "../src/contracts/index.js";
import { runVerification } from "../src/core/verify.js";
import { TOOL_VERSION } from "../src/version.js";

const expectedSha = "a".repeat(40);
const config = VerificationConfigSchema.parse({
  version: 1,
  provider: "coolify",
  coolify: {
    baseUrl: "https://coolify.example.test",
    resourceUuid: "application-1",
  },
  deployment: {},
  probes: [],
});

function coolifyResponse() {
  return Response.json([
    {
      deployment_uuid: "deployment-1",
      status: "finished",
      commit: expectedSha,
      created_at: new Date().toISOString(),
    },
  ]);
}

describe("verification orchestration", () => {
  it("keeps image digest evidence separate and still runs runtime markers", async () => {
    const digest = `sha256:${"b".repeat(64)}`.toUpperCase();
    const configWithImageMarker = VerificationConfigSchema.parse({
      version: 2,
      provider: "coolify",
      coolify: {
        baseUrl: "https://coolify.example.test",
        resourceUuid: "application-1",
      },
      deployment: { expectedImageDigest: digest },
      probes: [
        {
          name: "image-marker",
          url: "http://localhost/image",
          allowLocalHttp: true,
          imageDigestJsonPath: "image.digest",
        },
      ],
    });
    const report = await runVerification({
      config: configWithImageMarker,
      token: "read-only-token",
      expectedSha,
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        return url.pathname === "/image"
          ? Response.json({ image: { digest: digest.toLowerCase() } })
          : coolifyResponse();
      },
    });

    expect(report.decision).toBe("INCOMPLETE");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "deployment.image-digest",
        required: true,
        status: "UNSUPPORTED",
        failureCode: "DEPLOYMENT_IMAGE_DIGEST_UNSUPPORTED",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "http.image-marker", status: "PASS" }),
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        name: "deployment.image-digest",
        status: "UNSUPPORTED",
      }),
    );
  });

  it("rejects mutable tags and malformed image digests", async () => {
    await expect(
      runVerification({
        config,
        token: "read-only-token",
        expectedSha,
        expectedImageDigest: "release-1.2.3",
      }),
    ).rejects.toThrow("EXPECTED_IMAGE_DIGEST_INVALID");
  });

  it("does not let a mismatched runtime digest marker pass", async () => {
    const expectedDigest = `sha256:${"b".repeat(64)}`;
    const configWithImageMarker = VerificationConfigSchema.parse({
      version: 2,
      provider: "coolify",
      coolify: {
        baseUrl: "https://coolify.example.test",
        resourceUuid: "application-1",
      },
      deployment: { expectedImageDigest: expectedDigest },
      probes: [
        {
          name: "image-marker",
          url: "http://localhost/image",
          allowLocalHttp: true,
          imageDigestJsonPath: "image.digest",
        },
      ],
    });
    const report = await runVerification({
      config: configWithImageMarker,
      token: "read-only-token",
      expectedSha,
      expectedImageDigest: expectedDigest,
      fetchImpl: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        return url.pathname === "/image"
          ? Response.json({ image: { digest: `sha256:${"c".repeat(64)}` } })
          : coolifyResponse();
      },
    });

    expect(report.decision).toBe("FAIL");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "http.image-marker",
        status: "FAIL",
        failureCode: "RUNTIME_IMAGE_DIGEST_MISMATCH",
        evidence: expect.arrayContaining([
          expect.objectContaining({
            field: "imageDigest:image.digest",
            expected: expectedDigest,
            observed: `sha256:${"c".repeat(64)}`,
          }),
        ]),
      }),
    );
  });

  it("keeps an uncorrelated freshness warning visible without turning it into a required failure", async () => {
    const report = await runVerification({
      config,
      token: "read-only-token",
      expectedSha,
      fetchImpl: async () => coolifyResponse(),
    });
    expect(report.decision).toBe("PASS");
    expect(report.toolVersion).toBe(TOOL_VERSION);
    expect(
      report.checks.find((check) => check.id === "deployment.freshness"),
    ).toMatchObject({
      required: false,
      status: "WARN",
    });
  });

  it("fails the overall decision when the current run boundary is later than the deployment", async () => {
    const report = await runVerification({
      config,
      token: "read-only-token",
      expectedSha,
      startedAfter: new Date(Date.now() + 60_000).toISOString(),
      fetchImpl: async () => coolifyResponse(),
    });
    expect(report.decision).toBe("FAIL");
    expect(
      report.checks.find((check) => check.id === "deployment.freshness")
        ?.failureCode,
    ).toBe("DEPLOYMENT_STALE");
  });

  it("verifies a Vercel production deployment with its Git source SHA", async () => {
    const vercelConfig = VerificationConfigSchema.parse({
      version: 1,
      provider: "vercel",
      vercel: {
        projectId: "prj_demo",
        teamId: "team_demo",
        target: "production",
      },
      deployment: { timeoutSeconds: 10, pollIntervalSeconds: 1 },
      probes: [],
    });
    const createdAt = Date.now();
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.pathname === "/v7/deployments") {
        expect(url.searchParams.get("projectId")).toBe("prj_demo");
        expect(url.searchParams.get("teamId")).toBe("team_demo");
        expect(url.searchParams.get("target")).toBe("production");
        return Response.json({
          deployments: [{ uid: "dpl_demo", createdAt }],
        });
      }
      expect(url.pathname).toBe("/v13/deployments/dpl_demo");
      expect(url.searchParams.get("withGitRepoInfo")).toBe("true");
      return Response.json({
        id: "dpl_demo",
        projectId: "prj_demo",
        readyState: "READY",
        target: "production",
        createdAt,
        gitSource: { sha: expectedSha },
      });
    };
    const report = await runVerification({
      config: vercelConfig,
      token: "vercel-read-token",
      expectedSha,
      startedAfter: new Date(createdAt - 1_000).toISOString(),
      fetchImpl,
    });

    expect(report.decision).toBe("PASS");
    expect(report.provider).toBe("vercel");
    expect(report.resourceUuid).toBe("prj_demo");
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        name: "deployment.target-filter",
        status: "SUPPORTED",
      }),
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        name: "deployment.pagination",
        status: "SUPPORTED",
      }),
    );
    expect(report.checks.map((check) => check.id)).toEqual([
      "provider.vercel-api",
      "deployment.status",
      "deployment.commit",
      "deployment.freshness",
    ]);
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("reports Coolify target and team scope as unsupported", async () => {
    const report = await runVerification({
      config,
      token: "read-only-token",
      expectedSha,
      fetchImpl: async () => coolifyResponse(),
    });

    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        name: "deployment.target-filter",
        status: "UNSUPPORTED",
      }),
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        name: "deployment.team-scope",
        status: "UNSUPPORTED",
      }),
    );
  });

  it("marks supported capabilities unavailable when the provider API rejects access", async () => {
    const report = await runVerification({
      config,
      token: "read-only-token",
      expectedSha,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });

    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        name: "deployment.lookup",
        status: "UNAVAILABLE",
      }),
    );
    expect(report.decision).toBe("FAIL");
  });
});
