import { describe, expect, it } from "vitest";
import { evaluateImageDigestEvidence } from "../src/providers/deployment-evidence.js";

const expectedDigest = `sha256:${"a".repeat(64)}`;
const observedAt = "2026-09-30T08:00:00.000Z";

function evaluate(
  overrides: Partial<Parameters<typeof evaluateImageDigestEvidence>[0]> = {},
) {
  return evaluateImageDigestEvidence({
    provider: "coolify",
    expectedDigest,
    supported: true,
    observedAt,
    startedAt: Date.parse(observedAt),
    ...overrides,
  });
}

describe("image digest evidence contract", () => {
  it("passes only when the observed immutable digest exactly matches", () => {
    expect(evaluate({ observedDigest: expectedDigest })).toMatchObject({
      id: "deployment.image-digest",
      required: true,
      status: "PASS",
    });
  });

  it("fails when the observed immutable digest differs", () => {
    expect(
      evaluate({ observedDigest: `sha256:${"b".repeat(64)}` }),
    ).toMatchObject({
      status: "FAIL",
      failureCode: "DEPLOYMENT_IMAGE_DIGEST_MISMATCH",
    });
  });

  it("keeps a missing or malformed observed digest from passing", () => {
    expect(evaluate()).toMatchObject({
      status: "UNKNOWN",
      failureCode: "DEPLOYMENT_IMAGE_DIGEST_MISSING",
    });
    expect(evaluate({ observedDigest: "release-1.2.3" })).toMatchObject({
      status: "UNKNOWN",
      failureCode: "DEPLOYMENT_IMAGE_DIGEST_INVALID",
      evidence: [expect.objectContaining({ observed: null })],
    });
  });

  it("reports unsupported when the adapter has no immutable digest evidence", () => {
    expect(
      evaluate({ supported: false, observedDigest: expectedDigest }),
    ).toMatchObject({
      status: "UNSUPPORTED",
      failureCode: "DEPLOYMENT_IMAGE_DIGEST_UNSUPPORTED",
    });
  });

  it("does not treat mutable tags as digests", () => {
    expect(evaluate({ expectedDigest: "release-1.2.3" })).toMatchObject({
      status: "UNKNOWN",
      failureCode: "EXPECTED_IMAGE_DIGEST_INVALID",
    });
  });
});
