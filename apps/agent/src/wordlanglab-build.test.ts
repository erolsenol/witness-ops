import { describe, expect, it } from "vitest";

describe("WordLangLab release build evidence", () => {
  it("accepts only passed clean evidence with a successful bundle build", async () => {
    const { validateEvidence } = await import("../../../scripts/wordlanglab-build.mjs");
    const sha = "a".repeat(40);
    const evidence = { version: 1, sha, state: "passed", cleanSource: true, node: "22.23.3", pnpm: "12.4.2", gates: [{ executable: "pnpm", args: ["build", "--concurrency=1"], state: "passed" }] };
    expect(validateEvidence(evidence, sha)).toEqual(evidence);
    expect(() => validateEvidence({ ...evidence, cleanSource: false }, sha)).toThrow(/evidence is invalid/);
    expect(() => validateEvidence({ ...evidence, gates: [] }, sha)).toThrow(/evidence is invalid/);
    expect(() => validateEvidence(evidence, "b".repeat(40))).toThrow(/evidence is invalid/);
  });
});
