import { localDate } from './calendar.js';
import { selectProject, monitoringSchema, type LoadedConfig } from './config.js';
import { WitnessError } from './errors.js';
import { availableBytes } from './operations.js';
import { catalogBytes } from './quota.js';
import { listJobs } from './scheduler.js';
import { listBackups, loadVerification, validateArtifact, type Manifest, type VerificationReport } from './storage.js';

export const alertCodes = ['backup-missing', 'backup-stale', 'verification-missing', 'verification-stale', 'verification-failed',
  'artifact-invalid', 'catalog-unavailable', 'verification-metadata-invalid', 'jobs-unavailable', 'job-failed', 'job-retry-exhausted', 'job-interrupted', 'job-overdue',
  'disk-low', 'disk-unavailable', 'environment-mismatch', 'clock-future', 'verified-backup-stale', 'storage-quota-exhausted', 'storage-usage-unavailable'] as const;
export type AlertCode = typeof alertCodes[number];
export interface Alert {
  readonly code: AlertCode;
  readonly subject?: string;
}
export interface MonitorReport {
  readonly version: 1;
  readonly project: string;
  readonly observedAt: string;
  readonly healthy: boolean;
  readonly alerts: readonly Alert[];
  readonly latestBackupId: string | null;
  readonly latestVerifiedBackupId: string | null;
  readonly backupAgeSeconds: number | null;
  readonly verificationAgeSeconds: number | null;
  readonly verifiedBackupAgeSeconds: number | null;
  readonly storageBytes: number | null;
  readonly freeBytes: number | null;
  readonly thresholds: { readonly maximumBackupAgeSeconds: number; readonly maximumVerificationAgeSeconds: number; readonly maximumVerifiedBackupAgeSeconds: number; readonly minimumFreeBytes: number; readonly maximumStorageBytes: number | null };
}

export async function monitor(loaded: LoadedConfig, projectId: string, signal?: AbortSignal, now = new Date()): Promise<MonitorReport> {
  const project = selectProject(loaded.config, projectId);
  const policy = project.monitoring ?? monitoringSchema.parse({});
  const alerts: Alert[] = [];
  const add = (code: AlertCode, subject?: string): void => { alerts.push({ code, ...(subject ? { subject } : {}) }); };
  const checkCancellation = (): void => { if (signal?.aborted) throw new WitnessError('Monitoring cancelled.'); };
  const age = (timestamp: string): number => {
    if (Date.parse(timestamp) > now.getTime() + 60_000) add('clock-future');
    return Math.max(0, Math.floor((now.getTime() - Date.parse(timestamp)) / 1000));
  };
  checkCancellation();
  let backups: readonly Manifest[] | null = null;
  try { backups = await listBackups(loaded.storageDirectory, projectId); }
  catch { checkCancellation(); add('catalog-unavailable'); }
  const latest = backups?.[0];
  let verified: { manifest: Manifest; report: VerificationReport } | undefined;
  let latestReport: VerificationReport | undefined;
  if (backups) {
    if (!latest) add('backup-missing');
    for (const manifest of backups) {
      checkCancellation();
      if (manifest.environment !== project.environment) { add('environment-mismatch', manifest.id); continue; }
      try {
        const report = await loadVerification(loaded.storageDirectory, manifest);
        if (report && (!latestReport || report.verifiedAt > latestReport.verifiedAt)) latestReport = report;
        if (report?.passed && (!verified || (manifest.snapshotStartedAt ?? manifest.createdAt) > (verified.manifest.snapshotStartedAt ?? verified.manifest.createdAt))) verified = { manifest, report };
      } catch { checkCancellation(); add('verification-metadata-invalid', manifest.id); }
    }
    if (!verified) add('verification-missing');
    if (latestReport && !latestReport.passed) add('verification-failed', latestReport.backupId);
    const checked = new Set<string>();
    for (const item of [latest, verified?.manifest]) {
      if (!item || checked.has(item.id)) continue;
      checked.add(item.id);
      try { await validateArtifact(loaded.storageDirectory, item, signal); }
      catch { checkCancellation(); add('artifact-invalid', item.id); }
    }
  }
  const backupAgeSeconds = latest ? age(latest.createdAt) : null;
  const verificationAgeSeconds = verified ? age(verified.report.verifiedAt) : null;
  const verifiedBackupAgeSeconds = verified ? age(verified.manifest.snapshotStartedAt ?? verified.manifest.createdAt) : null;
  if (backupAgeSeconds !== null && backupAgeSeconds > policy.maximumBackupAgeSeconds) add('backup-stale', latest?.id);
  if (verificationAgeSeconds !== null && verificationAgeSeconds > policy.maximumVerificationAgeSeconds) add('verification-stale', verified?.manifest.id);
  if (verifiedBackupAgeSeconds !== null && verifiedBackupAgeSeconds > policy.maximumVerifiedBackupAgeSeconds) add('verified-backup-stale', verified?.manifest.id);
  try {
    const jobs = await listJobs(loaded, projectId);
    for (const job of jobs) {
      checkCancellation();
      if (job.status === 'interrupted') add('job-interrupted', job.id);
      if (job.status === 'running' && age(job.updatedAt) > loaded.config.timeoutSeconds + 30) add('job-overdue', job.id);
    }
    for (const kind of ['backup', 'verify'] as const) {
      const latestJob = jobs.filter((job) => job.kind === kind).sort((a, b) => b.slot.localeCompare(a.slot) || b.updatedAt.localeCompare(a.updatedAt))[0];
      if (latestJob && ['failed', 'abandoned'].includes(latestJob.status)) add('job-failed', latestJob.id);
      if (latestJob?.status === 'failed' && project.schedule && (latestJob.attempts >= project.schedule.maxAttempts
        || latestJob.slot !== localDate(now, project.schedule.timeZone).date)) add('job-retry-exhausted', latestJob.id);
    }
  } catch { checkCancellation(); add('jobs-unavailable'); }
  let freeBytes: number | null = null;
  try { freeBytes = await availableBytes(loaded.storageDirectory); if (freeBytes < loaded.config.minimumFreeBytes) add('disk-low'); }
  catch { checkCancellation(); add('disk-unavailable'); }
  let storageBytes: number | null = null;
  try {
    storageBytes = await catalogBytes(loaded.storageDirectory);
    if (loaded.config.maximumStorageBytes !== undefined && storageBytes >= loaded.config.maximumStorageBytes) add('storage-quota-exhausted');
  } catch { checkCancellation(); add('storage-usage-unavailable'); }
  checkCancellation();
  const unique = [...new Map(alerts.map((alert) => [`${alert.code}:${alert.subject ?? ''}`, alert])).values()]
    .sort((a, b) => a.code.localeCompare(b.code) || (a.subject ?? '').localeCompare(b.subject ?? ''));
  return { version: 1, project: projectId, observedAt: now.toISOString(), healthy: unique.length === 0, alerts: unique,
    latestBackupId: latest?.id ?? null, latestVerifiedBackupId: verified?.manifest.id ?? null, backupAgeSeconds, verificationAgeSeconds, verifiedBackupAgeSeconds, storageBytes, freeBytes,
    thresholds: { ...policy, minimumFreeBytes: loaded.config.minimumFreeBytes, maximumStorageBytes: loaded.config.maximumStorageBytes ?? null } };
}
