import { describe, expect, it } from "vitest";
import type { Project } from "@witness-ops/contracts";
import { parseCliArgs } from "./cli-args.ts";

const projects: Project[] = [
  { id: "one", name: "One", root: "/tmp/one", productionBranch: "main", nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: [], checks: [{ label: "Test", command: "npm", args: ["test"] }], build: { label: "Build", command: "npm", args: ["run", "build"], manifest: ".release-artifacts/{sha}/manifest.json", verify: { label: "Verify", command: "npm", args: ["run", "verify"] } } },
  { id: "two", name: "Two", root: "/tmp/two", productionBranch: "main", nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: [], checks: [{ label: "Test", command: "npm", args: ["test"] }] },
];

describe("parseCliArgs", () => {
  it("selects all checks in catalog order", () => {
    expect(parseCliArgs(["check", "--all"], projects)).toEqual({ action: "check", projectIds: ["one", "two"], dryRun: false });
  });

  it("supports a non-executing single-project build plan", () => {
    expect(parseCliArgs(["build", "--project", "one", "--dry-run"], projects)).toEqual({ action: "build", projectIds: ["one"], dryRun: true });
  });

  it("requires exact build evidence and explicit SHA confirmation for deploy", () => {
    const deployProjects: Project[] = [{ ...projects[0]!, deploy: {
      label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"],
      smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
    } }];
    const sha = "a".repeat(40);
    const hash = "b".repeat(64);
    const args = ["deploy", "--project", "one", "--sha", sha, "--manifest-hash", hash];
    expect(() => parseCliArgs(args, deployProjects)).toThrow(/--confirm/);
    expect(() => parseCliArgs([...args, "--confirm", "wrong"], deployProjects)).toThrow(/--confirm/);
    expect(parseCliArgs([...args, "--confirm", sha.slice(0, 12)], deployProjects)).toMatchObject({
      action: "deploy", projectIds: ["one"], expectedSha: sha, expectedManifestHash: hash,
    });
    expect(() => parseCliArgs(["deploy", "--all", "--sha", sha, "--manifest-hash", hash], deployProjects)).toThrow(/exactly one/);
  });

  it("requires a full SHA and exactly one rollback target", () => {
    const rollbackProjects = [{ ...projects[0]!, rollback: {
      label: "Rollback", command: "npm", args: ["run", "rollback", "{sha}"],
      smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
    } }];
    expect(parseCliArgs(["rollback", "--project", "one", "--sha", "a".repeat(40), "--dry-run"], rollbackProjects)).toMatchObject({
      action: "rollback", projectIds: ["one"], expectedSha: "a".repeat(40), dryRun: true,
    });
    expect(() => parseCliArgs(["rollback", "--project", "one", "--sha", "abc"], rollbackProjects)).toThrow(/full 40-character/);
    expect(() => parseCliArgs(["rollback", "--all", "--sha", "a".repeat(40)], rollbackProjects)).toThrow(/exactly one/);
  });

  it("rejects partial or unknown selections", () => {
    expect(() => parseCliArgs(["build", "--all"], projects)).toThrow(/not configured/);
    expect(() => parseCliArgs(["check", "--project", "missing"], projects)).toThrow(/Unknown project/);
    expect(() => parseCliArgs(["check", "--all", "--project", "one"], projects)).toThrow(/exactly one/);
  });
});
