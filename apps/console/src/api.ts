import {
  projectStateSchema,
  coolifySnapshotSchema,
  buildArtifactSummarySchema,
  runEventSchema,
  runRecordSchema,
  releaseEvidenceSnapshotSchema,
  type ProjectState,
  type CoolifySnapshot,
  type BuildArtifactSummary,
  type RunAction,
  type RunEvent,
  type RunRecord,
  type ReleaseEvidenceSnapshot,
} from "@deploy-relay/contracts";

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`İstek başarısız (${response.status}).`);
  return response.json() as Promise<unknown>;
}

export async function getProjects(): Promise<ProjectState[]> {
  return projectStateSchema.array().parse(await json("/api/projects"));
}

export async function getCoolify(): Promise<CoolifySnapshot> {
  return coolifySnapshotSchema.parse(await json("/api/coolify"));
}

export async function getReleaseEvidence(): Promise<ReleaseEvidenceSnapshot> {
  return releaseEvidenceSnapshotSchema.parse(await json("/api/release-evidence"));
}

export async function getRuns(): Promise<RunRecord[]> {
  return runRecordSchema.array().parse(await json("/api/runs"));
}

export async function getArtifacts(): Promise<BuildArtifactSummary[]> {
  return buildArtifactSummarySchema.array().parse(await json("/api/artifacts"));
}

export async function getEvents(runId: string): Promise<RunEvent[]> {
  return runEventSchema.array().parse(await json(`/api/runs/${encodeURIComponent(runId)}/events`));
}

export async function startRun(projectId: string, action: Exclude<RunAction, "deploy" | "rollback">): Promise<RunRecord> {
  return runRecordSchema.parse(await json("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Witness-Request": "1" },
    body: JSON.stringify({ projectId, action }),
  }));
}

export async function rollbackRun(projectId: string, expectedSha: string): Promise<RunRecord> {
  return runRecordSchema.parse(await json("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Witness-Request": "1" },
    body: JSON.stringify({ projectId, action: "rollback", expectedSha }),
  }));
}

export async function deployRun(projectId: string, artifact: BuildArtifactSummary): Promise<RunRecord> {
  return runRecordSchema.parse(await json("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Witness-Request": "1" },
    body: JSON.stringify({ projectId, action: "deploy", expectedSha: artifact.sha, expectedManifestHash: artifact.manifestHash }),
  }));
}
