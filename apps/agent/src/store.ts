import Database from "better-sqlite3";
import type { BuildArtifactSummary, RunAction, RunEvent, RunRecord, RunStatus } from "@deploy-relay/contracts";

export interface BuildArtifact extends BuildArtifactSummary {
  readonly manifest: string;
  readonly runId: string;
}

interface RunRow {
  id: string;
  project_id: string;
  action: RunAction;
  status: RunStatus;
  source_sha: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}

interface EventRow {
  sequence: number;
  run_id: string;
  at: string;
  kind: RunEvent["kind"];
  message: string;
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    action: row.action,
    status: row.status,
    sourceSha: row.source_sha,
    branch: row.branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function mapEvent(row: EventRow): RunEvent {
  return {
    sequence: row.sequence,
    runId: row.run_id,
    at: row.at,
    kind: row.kind,
    message: row.message,
  };
}

export class RunStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('plan', 'check', 'build', 'deploy', 'rollback', 'deploy-verify', 'db-status', 'db-drill')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'needs_attention')),
        source_sha TEXT,
        branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id, sequence);
    `);
    this.migrateActions();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS build_artifacts (
        project_id TEXT PRIMARY KEY,
        sha TEXT NOT NULL,
        manifest TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        created_at TEXT NOT NULL
      );
    `);
    const interrupted = this.#db.prepare("SELECT id FROM runs WHERE status IN ('running', 'queued')").all() as { id: string }[];
    this.#db.prepare("UPDATE runs SET status = 'needs_attention', updated_at = ? WHERE status IN ('running', 'queued')").run(new Date().toISOString());
    for (const row of interrupted) this.appendEvent(row.id, "error", "Agent yeniden başladı; tekrar denemeden önce bu işi inceleyin.");
  }

  close(): void { this.#db.close(); }

  private migrateActions(): void {
    const table = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() as { sql: string } | undefined;
    if (table?.sql.includes("CHECK (action IN ('plan', 'check', 'build', 'deploy', 'rollback', 'deploy-verify', 'db-status', 'db-drill'))")) return;
    this.#db.pragma("foreign_keys = OFF");
    try {
      this.#db.transaction(() => {
        this.#db.exec(`
          CREATE TABLE runs_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('plan', 'check', 'build', 'deploy', 'rollback', 'deploy-verify', 'db-status', 'db-drill')),
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'needs_attention')),
            source_sha TEXT,
            branch TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            error TEXT
          );
          INSERT INTO runs_new SELECT * FROM runs;
          DROP TABLE runs;
          ALTER TABLE runs_new RENAME TO runs;
        `);
      })();
    } finally {
      this.#db.pragma("foreign_keys = ON");
    }
    const violations = this.#db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) throw new Error("Run journal migration failed foreign-key validation.");
  }

  createRun(id: string, projectId: string, action: RunAction): RunRecord {
    const now = new Date().toISOString();
    this.#db.prepare("INSERT INTO runs (id, project_id, action, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(id, projectId, action, now, now);
    return this.getRun(id)!;
  }

  saveBuildArtifact(artifact: BuildArtifact): void {
    this.#db.prepare(`INSERT INTO build_artifacts (project_id, sha, manifest, manifest_hash, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET sha=excluded.sha, manifest=excluded.manifest,
        manifest_hash=excluded.manifest_hash, run_id=excluded.run_id, created_at=excluded.created_at`)
      .run(artifact.projectId, artifact.sha, artifact.manifest, artifact.manifestHash, artifact.runId, artifact.createdAt);
  }

  getBuildArtifact(projectId: string): BuildArtifact | null {
    const row = this.#db.prepare("SELECT * FROM build_artifacts WHERE project_id = ?").get(projectId) as {
      project_id: string; sha: string; manifest: string; manifest_hash: string; run_id: string; created_at: string;
    } | undefined;
    return row ? {
      projectId: row.project_id, sha: row.sha, manifest: row.manifest,
      manifestHash: row.manifest_hash, runId: row.run_id, createdAt: row.created_at,
    } : null;
  }

  listBuildArtifactSummaries(): BuildArtifactSummary[] {
    const rows = this.#db.prepare("SELECT project_id, sha, manifest_hash, created_at FROM build_artifacts ORDER BY created_at DESC").all() as {
      project_id: string; sha: string; manifest_hash: string; created_at: string;
    }[];
    return rows.map((row) => ({ projectId: row.project_id, sha: row.sha, manifestHash: row.manifest_hash, createdAt: row.created_at }));
  }

  getRun(id: string): RunRecord | null {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 30): RunRecord[] {
    const rows = this.#db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map(mapRun);
  }

  setStatus(id: string, status: RunStatus, details?: { sha?: string; branch?: string; error?: string }): void {
    this.#db.prepare(`UPDATE runs SET status = ?, source_sha = COALESCE(?, source_sha),
      branch = COALESCE(?, branch), error = COALESCE(?, error), updated_at = ? WHERE id = ?`)
      .run(status, details?.sha ?? null, details?.branch ?? null, details?.error ?? null, new Date().toISOString(), id);
  }

  appendEvent(id: string, kind: RunEvent["kind"], message: string): void {
    this.#db.prepare("INSERT INTO events (run_id, at, kind, message) VALUES (?, ?, ?, ?)")
      .run(id, new Date().toISOString(), kind, message);
  }

  listEvents(id: string, after = 0): RunEvent[] {
    const rows = this.#db.prepare("SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 200")
      .all(id, after) as EventRow[];
    return rows.map(mapEvent);
  }
}
