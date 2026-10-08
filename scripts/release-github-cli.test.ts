import { describe, expect, it } from "vitest";
import { getChecksumName, getReleaseTag, parseReleaseOptions } from "./release-github-cli.mjs";

describe("release GitHub CLI arguments", () => {
  it("requires release notes and accepts dry-run", () => {
    expect(parseReleaseOptions(["--", "--notes", "/tmp/notes.md", "--dry-run"])).toEqual({ notesPath: "/tmp/notes.md", dryRun: true });
    expect(() => parseReleaseOptions([])).toThrow(/--notes PATH/);
    expect(() => parseReleaseOptions(["--unknown"])).toThrow(/Unknown release option/);
  });

  it("derives tag and checksum names from the package version", () => {
    expect(getReleaseTag("0.1.0-alpha.9")).toBe("v0.1.0-alpha.9");
    expect(getChecksumName("0.1.0-alpha.9")).toBe("SHA256SUMS-alpha.9");
    expect(() => getReleaseTag("latest")).toThrow(/Invalid package version/);
  });
});
