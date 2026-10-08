import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VerificationReportSchema } from "../src/contracts/index.js";

const exampleDirectory = new URL("../examples/", import.meta.url);

async function loadExample(name: string) {
  const contents = await readFile(
    fileURLToPath(new URL(name, exampleDirectory)),
    "utf8",
  );
  return VerificationReportSchema.parse(JSON.parse(contents));
}

describe("published report v1 examples", () => {
  it("rejects fields outside the report v1 contract at every object level", async () => {
    const report = await loadExample("report-pass-v1.json");

    expect(() =>
      VerificationReportSchema.parse({ ...report, futureField: true }),
    ).toThrow();
    expect(() =>
      VerificationReportSchema.parse({
        ...report,
        checks: report.checks.map((check, index) =>
          index === 0 ? { ...check, futureField: true } : check,
        ),
      }),
    ).toThrow();
    const firstCheck = report.checks[0];
    if (!firstCheck) throw new Error("Expected report example checks.");
    expect(() =>
      VerificationReportSchema.parse({
        ...report,
        checks: [
          {
            ...firstCheck,
            evidence: [
              {
                source: "test",
                observedAt: report.createdAt,
                field: "sha",
                futureField: true,
              },
            ],
          },
          ...report.checks.slice(1),
        ],
      }),
    ).toThrow();
  });

  it("keeps correlated successful evidence as PASS", async () => {
    const report = await loadExample("report-pass-v1.json");
    expect(report.decision).toBe("PASS");
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("makes missing run correlation visible as an optional warning", async () => {
    const report = await loadExample("report-pass-uncorrelated-v1.json");
    expect(report.decision).toBe("PASS");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "deployment.freshness",
        required: false,
        status: "WARN",
        failureCode: "DEPLOYMENT_RUN_CORRELATION_UNAVAILABLE",
      }),
    );
  });

  it("keeps a stale deployment as a required failure", async () => {
    const report = await loadExample("report-stale-v1.json");
    expect(report.decision).toBe("FAIL");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "deployment.freshness",
        required: true,
        status: "FAIL",
        failureCode: "DEPLOYMENT_STALE",
      }),
    );
  });
});
