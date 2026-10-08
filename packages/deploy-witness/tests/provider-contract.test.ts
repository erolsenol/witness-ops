import { describe, expect, it } from "vitest";
import {
  type VerificationConfig,
  VerificationConfigSchema,
} from "../src/contracts/index.js";
import { runVerification } from "../src/core/verify.js";

const expectedSha = "c".repeat(40);
const wrongSha = "d".repeat(40);
const createdAt = Date.now();

type ProviderName = "coolify" | "vercel";

function config(provider: ProviderName): VerificationConfig {
  return VerificationConfigSchema.parse(
    provider === "coolify"
      ? {
          version: 1,
          provider,
          coolify: {
            baseUrl: "https://coolify.example.test",
            resourceUuid: "application-contract",
          },
          deployment: { timeoutSeconds: 10, pollIntervalSeconds: 1 },
          probes: [],
        }
      : {
          version: 1,
          provider,
          vercel: {
            projectId: "prj_contract",
            teamId: "team_contract",
            target: "production",
          },
          deployment: { timeoutSeconds: 10, pollIntervalSeconds: 1 },
          probes: [],
        },
  );
}

function providerResponse(
  provider: ProviderName,
  values: { status?: string; sha?: string; projectId?: string },
): typeof fetch {
  return async (input) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (provider === "coolify") {
      return Response.json([
        {
          deployment_uuid: "dpl_contract",
          status: values.status ?? "finished",
          ...(values.sha !== undefined ? { commit: values.sha } : {}),
          created_at: new Date(createdAt).toISOString(),
        },
      ]);
    }
    if (url.pathname === "/v7/deployments")
      return Response.json({
        deployments: [{ uid: "dpl_contract", createdAt }],
      });
    return Response.json({
      id: "dpl_contract",
      projectId: values.projectId ?? "prj_contract",
      readyState: values.status ?? "READY",
      target: "production",
      createdAt,
      ...(values.sha !== undefined ? { gitSource: { sha: values.sha } } : {}),
    });
  };
}

describe.each(["coolify", "vercel"] as const)(
  "%s provider contract",
  (provider) => {
    async function verify(values: {
      status?: string;
      sha?: string;
      projectId?: string;
      startedAfter?: string;
    }) {
      return runVerification({
        config: config(provider),
        token: "provider-contract-token",
        expectedSha,
        ...(values.startedAfter ? { startedAfter: values.startedAfter } : {}),
        fetchImpl: providerResponse(provider, values),
      });
    }

    it("passes only when the deployment is successful and its full SHA matches", async () => {
      const report = await verify({ sha: expectedSha });
      expect(report.decision).toBe("PASS");
      expect(
        report.checks.find((check) => check.id === "deployment.status")?.status,
      ).toBe("PASS");
      expect(
        report.checks.find((check) => check.id === "deployment.commit")?.status,
      ).toBe("PASS");
    });

    it("fails when the deployment SHA differs", async () => {
      const report = await verify({ sha: wrongSha });
      expect(report.decision).toBe("FAIL");
      expect(
        report.checks.find((check) => check.id === "deployment.commit"),
      ).toMatchObject({
        status: "FAIL",
        failureCode: "DEPLOYMENT_SHA_MISMATCH",
      });
    });

    it("enforces configured resource identity at the provider boundary", async () => {
      if (provider === "coolify") {
        let requestedUrl: URL | undefined;
        const report = await runVerification({
          config: config(provider),
          token: "provider-contract-token",
          expectedSha,
          fetchImpl: async (input) => {
            requestedUrl = new URL(
              input instanceof Request ? input.url : input.toString(),
            );
            return providerResponse(provider, { sha: expectedSha })(input);
          },
        });

        expect(requestedUrl?.pathname).toBe(
          "/api/v1/deployments/applications/application-contract",
        );
        expect(report.decision).toBe("PASS");
        return;
      }

      const report = await verify({
        sha: expectedSha,
        projectId: "prj_other",
      });
      expect(report.decision).toBe("FAIL");
      expect(
        report.checks.find((check) => check.id === "deployment.status"),
      ).toMatchObject({
        status: "FAIL",
        failureCode: "VERCEL_PROJECT_MISMATCH",
      });
    });

    it("keeps an unknown provider state from passing", async () => {
      const report = await verify({
        status: "provider-added-state",
        sha: expectedSha,
      });
      expect(report.decision).not.toBe("PASS");
      expect(
        report.checks.find((check) => check.id === "deployment.status")?.status,
      ).toBe("UNKNOWN");
    });

    it("keeps a missing commit from passing", async () => {
      const report = await verify({});
      expect(report.decision).not.toBe("PASS");
      expect(
        report.checks.find((check) => check.id === "deployment.commit")?.status,
      ).toBe("UNKNOWN");
    });

    it("fails when the deployment predates the CI run boundary", async () => {
      const report = await verify({
        sha: expectedSha,
        startedAfter: new Date(createdAt + 1_000).toISOString(),
      });
      expect(report.decision).toBe("FAIL");
      expect(
        report.checks.find((check) => check.id === "deployment.freshness"),
      ).toMatchObject({ status: "FAIL", failureCode: "DEPLOYMENT_STALE" });
    });

    it("fails closed on rejected credentials without exposing provider response text", async () => {
      const report = await runVerification({
        config: config(provider),
        token: "provider-contract-token",
        expectedSha,
        fetchImpl: async () =>
          new Response("provider-contract-token private body", {
            status: 401,
          }),
      });
      expect(report.decision).toBe("FAIL");
      expect(JSON.stringify(report)).not.toContain("provider-contract-token");
      expect(JSON.stringify(report)).not.toContain("private body");
      expect(
        report.checks.find((check) => check.id.startsWith("provider."))?.status,
      ).toBe("FAIL");
    });
  },
);
