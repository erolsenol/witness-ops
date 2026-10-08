import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { RunStore } from "./store.ts";

describe("RunStore", () => {
  it("serializes operations across store connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "witness-operation-lock-"));
    const path = join(directory, "runs.sqlite");
    const first = new RunStore(path);
    const second = new RunStore(path);
    try {
      const release = first.acquireOperation("first");
      expect(() => second.acquireOperation("second")).toThrow("Another WitnessOps operation is running");
      const waiting = second.waitForOperation("second");
      release();
      const releaseSecond = await waiting;
      releaseSecond();
    } finally {
      second.close();
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a run and ordered events", () => {
    const store = new RunStore(":memory:");
    try {
      const created = store.createRun("one", "guven", "plan");
      expect(created.status).toBe("queued");
      store.setStatus("one", "passed", { sha: "a".repeat(40) });
      store.appendEvent("one", "info", "Source inspected");
      store.appendEvent("one", "result", "Plan ready");
      expect(store.getRun("one")?.sourceSha).toBe("a".repeat(40));
      const events = store.listEvents("one");
      expect(events.map((event) => event.message)).toEqual(["Source inspected", "Plan ready"]);
      expect(store.listEvents("one", events[0]!.sequence)).toHaveLength(1);
      const build = store.createRun("build", "guven", "build");
      store.saveBuildArtifact({
        projectId: "guven", sha: "a".repeat(40), manifest: "/tmp/manifest.json",
        manifestHash: "b".repeat(64), runId: build.id, createdAt: "2026-01-01T00:00:00Z",
      });
      expect(store.getBuildArtifact("guven")?.manifest).toBe("/tmp/manifest.json");
      expect(store.listBuildArtifactSummaries()).toEqual([{
        projectId: "guven", sha: "a".repeat(40), manifestHash: "b".repeat(64), createdAt: "2026-01-01T00:00:00Z",
      }]);
    } finally { store.close(); }
  });

  it("marks unfinished jobs for review after a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "deploy-relay-store-"));
    const path = join(directory, "runs.sqlite");
    try {
      const first = new RunStore(path);
      first.createRun("queued", "guven", "check");
      first.createRun("running", "pawango", "plan");
      first.setStatus("running", "running");
      first.close();
      const abandoned = new Database(path);
      abandoned.prepare("UPDATE runs SET owner_pid = ?").run(999999);
      abandoned.close();
      const second = new RunStore(path);
      try {
        expect(second.getRun("queued")?.status).toBe("needs_attention");
        expect(second.getRun("running")?.status).toBe("needs_attention");
        expect(second.listEvents("running")[0]?.kind).toBe("error");
      } finally { second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves a live process's running job when another process opens the journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "witness-shared-journal-"));
    const path = join(directory, "runs.sqlite");
    const first = new RunStore(path);
    try {
      first.createRun("active", "guven", "deploy");
      first.setStatus("active", "running");
      const second = new RunStore(path);
      try {
        expect(second.getRun("active")?.status).toBe("running");
      } finally { second.close(); }
    } finally {
      first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["'plan', 'check'", "'plan', 'check', 'build'", "'plan', 'check', 'build', 'deploy'"])("migrates an existing journal with actions %s", (actions) => {
    const directory = mkdtempSync(join(tmpdir(), "deploy-relay-migration-"));
    const path = join(directory, "runs.sqlite");
    try {
      const old = new Database(path);
      old.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN (${actions})),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'needs_attention')),
          source_sha TEXT, branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
        );
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id), at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL
        );
        INSERT INTO runs VALUES ('old', 'guven', '${actions.includes("build") ? "build" : "check"}', 'passed', NULL, NULL, '2026-01-01', '2026-01-01', NULL);
        INSERT INTO events (run_id, at, kind, message) VALUES ('old', '2026-01-01', 'result', 'Passed');
      `);
      old.close();
      const store = new RunStore(path);
      try {
        expect(store.getRun("old")?.status).toBe("passed");
        expect(store.listEvents("old")[0]?.message).toBe("Passed");
        expect(store.createRun("new", "guven", "rollback").action).toBe("rollback");
      } finally { store.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
