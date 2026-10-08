import { describe, expect, it } from "vitest";
import { CheckResultSchema, decide } from "../src/contracts/index.js";

const check = (
  status: "PASS" | "FAIL" | "WARN" | "SKIP" | "UNKNOWN" | "UNSUPPORTED",
  required = true,
) =>
  CheckResultSchema.parse({
    id: "deployment.commit",
    category: "deployment",
    required,
    status,
    summary: "deployment result",
    durationMs: 0,
  });

describe("verification decision contract", () => {
  it("passes only when every required check passed", () => {
    expect(decide([check("PASS"), check("WARN", false)])).toBe("PASS");
  });

  it("fails when a required check fails", () => {
    expect(decide([check("PASS"), check("FAIL")])).toBe("FAIL");
  });

  it.each(["UNKNOWN", "UNSUPPORTED", "SKIP"] as const)(
    "does not treat required %s evidence as success",
    (status) => {
      expect(decide([check(status)])).toBe("INCOMPLETE");
    },
  );

  it("allows a non-required warning without hiding its result", () => {
    expect(decide([check("PASS"), check("WARN", false)])).toBe("PASS");
  });
});
