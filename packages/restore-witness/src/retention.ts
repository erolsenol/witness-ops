import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { localDate, monday } from './calendar.js';
import { selectProject, type LoadedConfig } from './config.js';
import { WitnessError } from './errors.js';
import { listJobs } from './scheduler.js';
import { backupDirectory, listBackups, loadVerification, validateArtifact, withProjectLock, type Manifest } from './storage.js';

export interface RetentionItem {
  readonly backupId: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly reasons: readonly string[];
}
export interface RetentionPlan {
  readonly project: string;
  readonly scope: 'local';
  readonly apply: boolean;
  readonly keep: readonly RetentionItem[];
  readonly remove: readonly RetentionItem[];
  readonly reclaimableBytes: number;
  readonly protectedVerifiedId: string | null;
  readonly blockedReason: string | null;
  readonly deleted: readonly string[];
}

export function evaluateRetention(backups: readonly Manifest[], policy: { readonly timeZone: string; readonly daily: number; readonly weekly: number; readonly monthly: number }, verifiedId: string | null, pendingIds: readonly string[] = []): { keep: RetentionItem[]; remove: RetentionItem[] } {
  const sorted = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const reasons = new Map<string, string[]>();
  const protect = (id: string, reason: string): void => { reasons.set(id, [...(reasons.get(id) ?? []), reason]); };
  if (sorted[0]) protect(sorted[0].id, 'newest-backup');
  if (verifiedId) protect(verifiedId, 'newest-verified');
  for (const id of pendingIds) protect(id, 'pending-job');
  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    const buckets = new Set<string>();
    for (const manifest of sorted) {
      const date = localDate(new Date(manifest.createdAt), policy.timeZone).date;
      const key = period === 'daily' ? date : period === 'weekly' ? monday(date) : date.slice(0, 7);
      if (buckets.has(key)) continue;
      if (buckets.size >= policy[period]) break;
      buckets.add(key);
      protect(manifest.id, `${period}:${key}`);
    }
  }
  const keep: RetentionItem[] = []; const remove: RetentionItem[] = [];
  for (const manifest of sorted) {
    const item: RetentionItem = { backupId: manifest.id, bytes: manifest.bytes, createdAt: manifest.createdAt, reasons: reasons.get(manifest.id) ?? [] };
    (item.reasons.length ? keep : remove).push(item);
  }
  return { keep, remove };
}

export async function prune(loaded: LoadedConfig, projectId: string, apply: boolean, signal?: AbortSignal): Promise<RetentionPlan> {
  const project = selectProject(loaded.config, projectId);
  if (!project.retention) throw new WitnessError('This project has no retention policy.');
  return withProjectLock(loaded.storageDirectory, projectId, async () => {
    const backups = await listBackups(loaded.storageDirectory, projectId);
    let verifiedId: string | null = null;
    for (const manifest of backups) {
      const report = await loadVerification(loaded.storageDirectory, manifest);
      if (report?.passed && !verifiedId) {
        await validateArtifact(loaded.storageDirectory, manifest, signal);
        verifiedId = manifest.id;
      }
    }
    const pendingIds = (await listJobs(loaded, projectId)).filter((job) => job.status === 'running' || job.status === 'interrupted'
      || (job.status === 'failed' && job.attempts < (project.schedule?.maxAttempts ?? 0) && job.slot === localDate(new Date(), job.timeZone).date))
      .flatMap((job) => job.backupId ? [job.backupId] : []);
    const plan = evaluateRetention(backups, project.retention ?? { timeZone: 'UTC', daily: 7, weekly: 4, monthly: 12 }, verifiedId, pendingIds);
    const blockedReason = backups.some((manifest) => manifest.environment !== project.environment)
      ? 'Catalog contains backups from a different project environment.'
      : verifiedId === null && plan.remove.length > 0 ? 'No intact locally verified recovery point is available.' : null;
    const deleted: string[] = [];
    if (apply) {
      if (blockedReason) throw new WitnessError(`Retention blocked: ${blockedReason}`);
      // Validate the entire selected catalog before the first destructive operation.
      for (const manifest of backups) await validateArtifact(loaded.storageDirectory, manifest, signal);
      for (const item of plan.remove) {
        if (signal?.aborted) throw new WitnessError('Retention cancelled; inspect catalog for already completed deletions.');
        const source = backupDirectory(loaded.storageDirectory, item.backupId);
        const trash = join(loaded.storageDirectory, `.pruned-${item.backupId}-${randomUUID()}`);
        await rename(source, trash);
        try { await rm(trash, { recursive: true }); }
        catch { throw new WitnessError('Retention cleanup failed. Inspect .pruned directories; retained recovery points are untouched.'); }
        deleted.push(item.backupId);
      }
    }
    return { project: projectId, scope: 'local', apply, ...plan, protectedVerifiedId: verifiedId, blockedReason,
      reclaimableBytes: plan.remove.reduce((total, item) => total + item.bytes, 0), deleted };
  });
}
