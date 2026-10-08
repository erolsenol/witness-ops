import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CheckResult,
  httpProbeCheckId,
  VerificationConfigSchema,
} from "../src/contracts/index.js";
import { parseProbeConcurrency } from "../src/core/probe-options.js";
import { runVerification } from "../src/core/verify.js";
import { verifyHttpProbe } from "../src/probes/http.js";

vi.mock("../src/probes/http.js", () => ({ verifyHttpProbe: vi.fn() }));

const expectedSha = "a".repeat(40);
const config = VerificationConfigSchema.parse({
  version: 2,
  provider: "coolify",
  coolify: {
    baseUrl: "https://coolify.example.test",
    resourceUuid: "app",
  },
  deployment: {},
  probes: Array.from({ length: 6 }, (_, index) => ({
    name: `probe-${index}`,
    url: `https://runtime.example.test/${index}`,
  })),
});

function result(name: string): CheckResult {
  return {
    id: httpProbeCheckId(name),
    category: "runtime",
    required: true,
    status: "PASS",
    summary: "Runtime matched.",
    durationMs: 0,
    evidence: [],
  };
}

function providerResponse(): Response {
  return Response.json([
    {
      deployment_uuid: "deployment",
      status: "finished",
      commit: expectedSha,
      created_at: new Date().toISOString(),
    },
  ]);
}

beforeEach(() => vi.resetAllMocks());

describe("runtime probe concurrency", () => {
  it.each([undefined, 1, 2, 20])(
    "bounds active probes and preserves ordering with concurrency %s",
    async (probeConcurrency) => {
      const started: string[] = [];
      let active = 0;
      let maximumActive = 0;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(verifyHttpProbe).mockImplementation(async (probe) => {
        started.push(probe.name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
        return result(probe.name);
      });
      const running = runVerification({
        config,
        token: "test-token",
        expectedSha,
        ...(probeConcurrency !== undefined ? { probeConcurrency } : {}),
        fetchImpl: async () => providerResponse(),
      });
      const expectedActive = Math.min(probeConcurrency ?? 4, 6);
      try {
        await vi.waitFor(() => expect(started).toHaveLength(expectedActive));
      } finally {
        release();
      }
      const report = await running;
      expect(maximumActive).toBe(expectedActive);
      expect(started).toHaveLength(6);
      expect(report.decision).toBe("PASS");
      expect(
        report.checks
          .filter((check) => check.category === "runtime")
          .map((check) => check.id),
      ).toEqual(config.probes.map((probe) => httpProbeCheckId(probe.name)));
    },
  );

  it("keeps config order when later probes finish first", async () => {
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const completed: string[] = [];
    vi.mocked(verifyHttpProbe).mockImplementation(async (probe) => {
      if (probe.name === "probe-0") await first;
      completed.push(probe.name);
      return result(probe.name);
    });
    const running = runVerification({
      config,
      token: "test-token",
      expectedSha,
      probeConcurrency: 2,
      fetchImpl: async () => providerResponse(),
    });
    try {
      await vi.waitFor(() => expect(completed).toHaveLength(5));
    } finally {
      releaseFirst();
    }
    const report = await running;
    expect(completed.at(-1)).toBe("probe-0");
    expect(
      report.checks
        .filter((check) => check.category === "runtime")
        .map((check) => check.id),
    ).toEqual(config.probes.map((probe) => httpProbeCheckId(probe.name)));
  });

  it.each([0, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid concurrency %s before provider I/O",
    async (probeConcurrency) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        runVerification({
          config,
          token: "test-token",
          expectedSha,
          probeConcurrency,
          fetchImpl,
        }),
      ).rejects.toThrow("PROBE_CONCURRENCY_INVALID");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(verifyHttpProbe).not.toHaveBeenCalled();
    },
  );

  it("skips every probe with the same identity when provider evidence fails", async () => {
    const report = await runVerification({
      config,
      token: "test-token",
      expectedSha,
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    expect(verifyHttpProbe).not.toHaveBeenCalled();
    expect(
      report.checks.filter((check) => check.category === "runtime"),
    ).toEqual(
      config.probes.map((probe) =>
        expect.objectContaining({
          id: httpProbeCheckId(probe.name),
          status: "SKIP",
        }),
      ),
    );
  });
});

describe("shared concurrency input parsing", () => {
  it.each([1, 20, "1", "20"])("accepts %s", (input) => {
    expect(parseProbeConcurrency(input)).toBe(Number(input));
  });
  it("defaults to four workers", () => expect(parseProbeConcurrency()).toBe(4));
  it.each([
    null,
    true,
    [],
    "",
    "2.5",
    "2e0",
    "0x2",
    " 4 ",
    "secret-value",
    "21",
  ])("rejects invalid input %s without echoing it", (input) => {
    expect(() => parseProbeConcurrency(input)).toThrow(
      "PROBE_CONCURRENCY_INVALID: Provide an integer from 1 to 20.",
    );
  });
});
