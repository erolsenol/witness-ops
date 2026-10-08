import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Project, ReleaseEvidenceSnapshot } from "@deploy-relay/contracts";
import { Scheduler } from "./scheduler.ts";
import { RunStore } from "./store.ts";

vi.mock("./tool-runner.ts", () => ({
  reportPath: () => "/nonexistent/witness-report.json",
  runDatabaseCheck: vi.fn(),
  runDeployVerification: vi.fn(),
}));

import { runDatabaseCheck, runDeployVerification } from "./tool-runner.ts";

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function healthyRollbackEvidence(sha: string): ReleaseEvidenceSnapshot {
  return {
    availability: "ready", checkedAt: new Date().toISOString(), current: null,
    rollbackCandidates: [{
      sha, state: "healthy", startedAt: new Date().toISOString(), finishedAt: null,
      images: [{ name: "app", reference: `local-release/app:sha-${sha}`, imageId: `sha256:${"1".repeat(64)}` }],
    }],
    runtimeImages: [], runtimeMatchesCurrent: true, error: null,
  };
}

describe("Scheduler deploy reconciliation", () => {
  it("records a failed pre-deploy recovery drill without starting deployment", async () => {
    const root = mkdtempSync(join(tmpdir(), "witness-predeploy-"));
    const store = new RunStore(":memory:");
    let deployCalls = 0;
    try {
      git(root, ["init", "-q", "-b", "main"]);
      writeFileSync(join(root, ".gitignore"), ".release-artifacts/\n");
      writeFileSync(join(root, "source.txt"), "source\n");
      git(root, ["add", "."]);
      git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"]);
      const sha = git(root, ["rev-parse", "HEAD"]);
      const manifest = join(root, ".release-artifacts", sha, "manifest.json");
      mkdirSync(join(root, ".release-artifacts", sha), { recursive: true });
      writeFileSync(manifest, "bundle");
      const manifestHash = createHash("sha256").update("bundle").digest("hex");
      const project: Project = {
        id: "test", name: "Test", root, productionBranch: "main", nodeVersion: process.versions.node,
        packageManager: "npm@11", coolifyApplications: [], checks: [],
        build: { label: "Build", command: "npm", args: ["run", "build"], manifest: ".release-artifacts/{sha}/manifest.json", verify: { label: "Verify", command: "npm", args: ["run", "verify", "{manifest}"] } },
        deploy: { label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"], smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] } },
        databaseRecovery: { configPath: join(root, "recovery.json"), projectId: "test", beforeDeploy: true },
      };
      store.createRun("build", project.id, "build");
      store.saveBuildArtifact({ projectId: project.id, sha, manifest, manifestHash, runId: "build", createdAt: new Date().toISOString() });
      vi.mocked(runDatabaseCheck).mockRejectedValueOnce(new Error("Recovery drill failed"));
      const scheduler = new Scheduler([project], store, async () => { deployCalls += 1; });
      const run = scheduler.enqueue(project.id, "deploy", { sha, manifestHash });
      await scheduler.idle();
      expect(store.getRun(run.id)?.status).toBe("failed");
      expect(deployCalls).toBe(0);
      expect(runDatabaseCheck).toHaveBeenCalledWith(project, "drill", run.id, "db");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts a failed independent verification into needs_attention after deployment", async () => {
    const root = mkdtempSync(join(tmpdir(), "witness-postdeploy-"));
    const store = new RunStore(":memory:");
    try {
      git(root, ["init", "-q", "-b", "main"]);
      writeFileSync(join(root, ".gitignore"), ".release-artifacts/\n");
      writeFileSync(join(root, "source.txt"), "source\n");
      git(root, ["add", "."]);
      git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"]);
      const sha = git(root, ["rev-parse", "HEAD"]);
      const manifest = join(root, ".release-artifacts", sha, "manifest.json");
      mkdirSync(join(root, ".release-artifacts", sha), { recursive: true });
      writeFileSync(manifest, "bundle");
      const manifestHash = createHash("sha256").update("bundle").digest("hex");
      const project: Project = {
        id: "test", name: "Test", root, productionBranch: "main", nodeVersion: process.versions.node,
        packageManager: "npm@11", coolifyApplications: [], checks: [],
        build: { label: "Build", command: "npm", args: ["run", "build"], manifest: ".release-artifacts/{sha}/manifest.json", verify: { label: "Verify", command: "npm", args: ["run", "verify", "{manifest}"] } },
        deploy: { label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"], smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] } },
        deployVerification: { configPath: join(root, "deploy.json") },
      };
      store.createRun("build", project.id, "build");
      store.saveBuildArtifact({ projectId: project.id, sha, manifest, manifestHash, runId: "build", createdAt: new Date().toISOString() });
      vi.mocked(runDeployVerification).mockRejectedValueOnce(new Error("Provider SHA mismatch"));
      const scheduler = new Scheduler([project], store, async () => undefined);
      const run = scheduler.enqueue(project.id, "deploy", { sha, manifestHash });
      await scheduler.idle();
      expect(store.getRun(run.id)?.status).toBe("needs_attention");
      expect(store.listEvents(run.id).at(-1)?.message).toContain("Provider SHA mismatch");
      expect(runDeployVerification).toHaveBeenCalledWith(project, sha, run.id, "deploy", expect.any(String));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("marks a failed native deploy for review instead of retrying it", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-relay-scheduler-"));
    const store = new RunStore(":memory:");
    try {
      git(root, ["init", "-q", "-b", "main"]);
      writeFileSync(join(root, ".gitignore"), ".release-artifacts/\n");
      writeFileSync(join(root, "source.txt"), "source\n");
      git(root, ["add", "."]);
      git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"]);
      const sha = git(root, ["rev-parse", "HEAD"]);
      const manifest = join(root, ".release-artifacts", sha, "manifest.json");
      mkdirSync(join(root, ".release-artifacts", sha), { recursive: true });
      writeFileSync(manifest, "bundle");
      const manifestHash = createHash("sha256").update("bundle").digest("hex");
      const project: Project = {
        id: "test", name: "Test", root, productionBranch: "main", nodeVersion: process.versions.node,
        packageManager: "npm@11", coolifyApplications: [], checks: [{ label: "Check", command: "npm", args: ["test"] }],
        build: { label: "Build", command: "npm", args: ["run", "build"], manifest: ".release-artifacts/{sha}/manifest.json", verify: { label: "Verify", command: "npm", args: ["run", "verify", "{manifest}"] } },
        deploy: { label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"], smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] } },
      };
      store.createRun("build", project.id, "build");
      store.saveBuildArtifact({ projectId: project.id, sha, manifest, manifestHash, runId: "build", createdAt: new Date().toISOString() });
      const scheduler = new Scheduler([project], store, async (_project, _command, args) => {
        if (args.includes("deploy")) throw new Error("Receiver outcome unknown");
      });
      const run = scheduler.enqueue(project.id, "deploy", { sha, manifestHash });
      await scheduler.idle();
      expect(store.getRun(run.id)?.status).toBe("needs_attention");
      expect(store.listEvents(run.id).at(-1)?.message).toMatch(/Receiver outcome unknown/);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks an uncertain rollback for review and never retries it", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-relay-rollback-scheduler-"));
    const store = new RunStore(":memory:");
    let rollbackCalls = 0;
    try {
      git(root, ["init", "-q", "-b", "main"]);
      writeFileSync(join(root, ".gitignore"), ".release-artifacts/\n");
      writeFileSync(join(root, "source.txt"), "source\n");
      git(root, ["add", "."]);
      git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"]);
      const targetSha = "b".repeat(40);
      const project: Project = {
        id: "test", name: "Test", root, productionBranch: "main", nodeVersion: process.versions.node,
        packageManager: "npm@11", coolifyApplications: [], checks: [{ label: "Check", command: "npm", args: ["test"] }],
        rollback: {
          label: "Rollback", command: "npm", args: ["run", "rollback", "app-{sha}"],
          smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
        },
      };
      const scheduler = new Scheduler([project], store, async (_project, _command, args) => {
        if (args.includes("rollback")) rollbackCalls += 1;
        if (args.includes("smoke")) throw new Error("SHA smoke failed");
      }, async () => healthyRollbackEvidence(targetSha));
      const run = scheduler.enqueue(project.id, "rollback", { sha: targetSha });
      await scheduler.idle();
      expect(store.getRun(run.id)?.status).toBe("needs_attention");
      expect(rollbackCalls).toBe(1);
      expect(store.listEvents(run.id).at(-1)?.message).toMatch(/SHA smoke failed/);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechecks rollback evidence after the operation lock becomes available", async () => {
    const root = mkdtempSync(join(tmpdir(), "witness-rollback-evidence-"));
    const store = new RunStore(":memory:");
    try {
      git(root, ["init", "-q", "-b", "main"]);
      writeFileSync(join(root, "source.txt"), "source\n");
      git(root, ["add", "."]);
      git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"]);
      const targetSha = "b".repeat(40);
      const project: Project = {
        id: "test", name: "Test", root, productionBranch: "main", nodeVersion: process.versions.node,
        packageManager: "npm@11", coolifyApplications: [], checks: [{ label: "Check", command: "npm", args: ["test"] }],
        rollback: {
          label: "Rollback", command: "npm", args: ["run", "rollback", "app-{sha}"],
          smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
        },
      };
      let evidence = healthyRollbackEvidence(targetSha);
      let evidenceReads = 0;
      let receiverCalls = 0;
      const scheduler = new Scheduler([project], store, async () => { receiverCalls += 1; }, async () => {
        evidenceReads += 1;
        return evidence;
      });
      const unlock = store.acquireOperation("another-operation");
      const run = scheduler.enqueue(project.id, "rollback", { sha: targetSha });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(evidenceReads).toBe(0);
      evidence = { ...evidence, runtimeMatchesCurrent: false };
      unlock();
      await scheduler.idle();
      expect(evidenceReads).toBe(1);
      expect(receiverCalls).toBe(0);
      expect(store.getRun(run.id)?.status).toBe("failed");
      expect(store.listEvents(run.id).at(-1)?.message).toContain("evidence changed while queued");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
