import { describe, expect, it } from "vitest";
import {
  httpProbeCheckId,
  VerificationConfigSchema,
} from "../src/contracts/index.js";

describe("HTTP check identity", () => {
  it.each([
    ["Runtime Version", "http.runtime-version"],
    ["!!!", "http.probe"],
    ["a".repeat(64), `http.${"a".repeat(48)}`],
  ])("preserves the check ID for %s", (name, expected) => {
    expect(httpProbeCheckId(name)).toBe(expected);
  });

  describe.each([1, 2])("config v%s", (version) => {
    it.each([
      ["health", "HEALTH"],
      ["runtime version", "runtime@version"],
      ["!!!", "probe"],
      [`${"a".repeat(48)}1`, `${"a".repeat(48)}2`],
    ])("rejects colliding names %s and %s", (first, second) => {
      const result = VerificationConfigSchema.safeParse({
        version,
        provider: "coolify",
        coolify: {
          baseUrl: "https://coolify.example.test",
          resourceUuid: "app",
        },
        deployment: {},
        probes: [first, second].map((name) => ({
          name,
          url: "https://app.example.test/health",
        })),
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected collision rejection.");
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["probes", 1, "name"] }),
      );
    });
  });
});
