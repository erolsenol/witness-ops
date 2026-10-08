import { describe, expect, it } from "vitest";
import { collectDoctorChecks, formatDoctorReport } from "./doctor.mjs";

describe("formatDoctorReport", () => {
  it("renders status without exposing unrelated configuration", () => {
    expect(formatDoctorReport([{ status: "ok", label: "Node.js", detail: "v24.21.0" }, { status: "error", label: "Shared command lock", detail: "not writable; checks and builds cannot start" }])).toBe("✓ Node.js: v24.21.0\n✗ Shared command lock: not writable; checks and builds cannot start");
  });

  it("identifies unsupported runtime and inaccessible release prerequisites", () => {
    const checks = collectDoctorChecks({ root: process.cwd(), platform: "linux", nodeVersion: "v18.0.0", pnpmVersion: "9.0.0", xcodePath: null, projects: [{ id: "sample", root: "/path/that/does/not/exist" }], devRunPath: "/path/that/does/not/exist/dev-run", lockPath: "/path/that/does/not/exist/heavy-command.lock" });
    expect(checks.filter((check) => check.status === "error").map((check) => check.label)).toEqual(["Platform", "Node.js", "pnpm", "Xcode command line tools", "Shared command runner", "Shared command lock"]);
    expect(checks.find((check) => check.label === "Project sample")?.status).toBe("warning");
  });
});
