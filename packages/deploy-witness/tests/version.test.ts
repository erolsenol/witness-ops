import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TOOL_VERSION } from "../src/version.js";

describe("package version", () => {
  it("keeps CLI and report versions synchronized with package metadata", async () => {
    const packageMetadata: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (
      typeof packageMetadata !== "object" ||
      packageMetadata === null ||
      !("version" in packageMetadata) ||
      typeof packageMetadata.version !== "string"
    ) {
      throw new Error("PACKAGE_VERSION_MISSING");
    }

    expect(TOOL_VERSION).toBe(packageMetadata.version);
  });
});
