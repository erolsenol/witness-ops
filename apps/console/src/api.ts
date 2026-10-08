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
  const headers = new Headers(init?.headers);
  const token = window.sessionStorage.getItem("witness-agent-token");
  if (token) headers.set("X-Witness-Token", token);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw new Error(`İstek başarısız (${response.status}).`);
  return response.json() as Promise<unknown>;
}

export async function openReport(runId: string, kind: "manual" | "deploy" | "db"): Promise<void> {
  const headers = new Headers();
  const token = window.sessionStorage.getItem("witness-agent-token");
  if (token) headers.set("X-Witness-Token", token);
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/report?kind=${kind}`, { headers });
  if (!response.ok) throw new Error(`Rapor açılamadı (${response.status}).`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `witness-${runId}-${kind}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function getProjects(): Promise<ProjectState[]> {
  return projectStateSchema.array().parse(await json("/api/projects"));
}

export async function getCoolify(): Promise<CoolifySnapshot> {
  return coolifySnapshotSchema.parse(await json("/api/coolify"));
}

export async function getReleaseEvidence(projectId: string): Promise<ReleaseEvidenceSnapshot> {
  return releaseEvidenceSnapshotSchema.parse(await json(`/api/release-evidence?projectId=${encodeURIComponent(projectId)}`));
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
