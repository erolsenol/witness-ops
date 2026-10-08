import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { selectProject, type LoadedConfig, type Project } from './config.js';
import { WitnessError } from './errors.js';
import { backup, doctor, verify } from './operations.js';
import type { ProcessOptions } from './process.js';
import { pushBackup, recordRemoteVerification, withRemoteBackup } from './s3.js';
import { atomicJson, loadManifest, type VerificationReport } from './storage.js';

export interface DrillReport {
  readonly version: 1; readonly id: string; readonly project: string; readonly backupId: string;
  readonly startedAt: string; readonly completedAt: string; readonly origin: 'local' | 's3';
  readonly sourceEnvironment: Project['environment'];
  readonly backupDurationMs: number; readonly uploadDurationMs: number | null;
  readonly recoveryDurationMs: number; readonly recoveryPointAgeSeconds: number;
  readonly passed: boolean; readonly verification: VerificationReport;
}

export async function drill(loaded: LoadedConfig, projectId: string, remote: boolean, options: ProcessOptions): Promise<DrillReport> {
  const project = selectProject(loaded.config, projectId);
  if (project.assertions.length === 0) throw new WitnessError('Drills require at least one application table assertion.');
  if (remote && (!loaded.config.s3 || !project.encryption)) throw new WitnessError('Remote drills require encrypted S3 storage.');
  if (!(await doctor(loaded, projectId, options)).healthy) throw new WitnessError('Recovery host is not ready. Run doctor before the drill.');
  const started = Date.now();
  const manifest = await backup(loaded, projectId, options);
  const backupFinished = Date.now();
  let uploadDurationMs: number | null = null;
  if (remote) { const at = Date.now(); await pushBackup(loaded, manifest.id, options); uploadDurationMs = Date.now() - at; }
  const recoveryStarted = Date.now();
  const verification = remote ? await withRemoteBackup(loaded, projectId, manifest.id, options, async (temporary) => {
    const result = await verify(temporary, manifest.id, options);
    await recordRemoteVerification(loaded, await loadManifest(temporary.storageDirectory, manifest.id), result, options);
    return result;
  }) : await verify(loaded, manifest.id, options);
  const finished = Date.now();
  const report: DrillReport = { version: 1, id: randomUUID(), project: projectId, backupId: manifest.id,
    startedAt: new Date(started).toISOString(), completedAt: new Date(finished).toISOString(), origin: remote ? 's3' : 'local', sourceEnvironment: project.environment,
    backupDurationMs: backupFinished - started, uploadDurationMs, recoveryDurationMs: finished - recoveryStarted,
    recoveryPointAgeSeconds: Math.max(0, Math.ceil((finished - Date.parse(manifest.snapshotStartedAt ?? manifest.createdAt)) / 1000)),
    passed: verification.passed, verification };
  const directory = join(loaded.storageDirectory, 'drills', projectId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(join(directory, `${report.id}.json`), report);
  return report;
}
