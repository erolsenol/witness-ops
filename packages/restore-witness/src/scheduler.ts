import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { localDate, scheduledMinutes } from './calendar.js';
import { selectProject, projectId, timeZoneSchema, type LoadedConfig } from './config.js';
import { safeMessage, WitnessError } from './errors.js';
import { backup, verify } from './operations.js';
import type { ProcessOptions } from './process.js';
import { pushBackup } from './s3.js';
import { atomicJson, backupIdSchema, listBackups, loadManifest, readJson, withProjectLock, type Manifest, type VerificationReport } from './storage.js';

export const jobIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}-(?:backup|verify)-\d{4}-\d{2}-\d{2}$/);
export const jobSchema = z.strictObject({
  version: z.literal(1), id: jobIdSchema, project: projectId, kind: z.enum(['backup', 'verify']),
  slot: z.string().date(), timeZone: timeZoneSchema,
  status: z.enum(['running', 'interrupted', 'failed', 'succeeded', 'abandoned']),
  attempts: z.number().int().min(0).max(10), updatedAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime().optional(), backupId: backupIdSchema.optional(),
  uploaded: z.boolean().default(false), error: z.string().max(500).optional(),
}).superRefine((job, ctx) => {
  if ((job.status === 'succeeded' || job.uploaded) && !job.backupId) ctx.addIssue({ code: 'custom', message: 'Completed effects require a recorded backup identity.' });
});
export type Job = z.infer<typeof jobSchema>;
export interface SchedulerOperations {
  readonly now: () => Date;
  readonly backup: (loaded: LoadedConfig, project: string, options: ProcessOptions) => Promise<Manifest>;
  readonly push: (loaded: LoadedConfig, id: string, options: ProcessOptions) => Promise<unknown>;
  readonly verify: (loaded: LoadedConfig, id: string, options: ProcessOptions) => Promise<VerificationReport>;
}
const defaults: SchedulerOperations = { now: () => new Date(), backup, push: pushBackup, verify };

function schedulerLock(project: string): string { return `schedule-${createHash('sha256').update(project).digest('hex').slice(0, 32)}`; }
function directory(loaded: LoadedConfig): string { return join(loaded.storageDirectory, 'jobs'); }
function path(loaded: LoadedConfig, id: string): string {
  if (!jobIdSchema.safeParse(id).success) throw new WitnessError('Invalid job identifier.');
  return join(directory(loaded), `${id}.json`);
}
async function loadJob(loaded: LoadedConfig, id: string): Promise<Job | null> {
  const file = path(loaded, id);
  const exists = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) return null;
  const result = jobSchema.safeParse(await readJson(file));
  if (!result.success || result.data.id !== id || id !== `${result.data.project}-${result.data.kind}-${result.data.slot}`) throw new WitnessError('Invalid job metadata.');
  return result.data;
}
async function saveJob(loaded: LoadedConfig, job: Job): Promise<void> {
  await atomicJson(path(loaded, job.id), jobSchema.parse(job));
}

export async function listJobs(loaded: LoadedConfig, project: string): Promise<readonly Job[]> {
  selectProject(loaded.config, project);
  const entries = await readdir(directory(loaded)).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const jobs: Job[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || !jobIdSchema.safeParse(entry.slice(0, -5)).success) continue;
    const job = await loadJob(loaded, entry.slice(0, -5));
    if (job?.project === project) jobs.push(job);
  }
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface JobCompactionResult {
  readonly project: string;
  readonly beforeDate: string;
  readonly dryRun: boolean;
  readonly candidates: readonly string[];
  readonly protectedJobs: readonly { readonly id: string; readonly reason: string }[];
  readonly removed: readonly string[];
}

export async function compactJobs(loaded: LoadedConfig, project: string, beforeDate: string, apply = false, now = new Date()): Promise<JobCompactionResult> {
  selectProject(loaded.config, project);
  const cutoff = z.string().date().safeParse(beforeDate);
  if (!cutoff.success) throw new WitnessError('Invalid job history cutoff date. Use YYYY-MM-DD.');
  if (beforeDate > now.toISOString().slice(0, 10)) throw new WitnessError('Job history cutoff cannot be in the future.');

  return withProjectLock(loaded.storageDirectory, schedulerLock(project), async () => {
    const candidates: string[] = [];
    const protectedJobs: { id: string; reason: string }[] = [];
    for (const job of await listJobs(loaded, project)) {
      if (job.slot >= beforeDate) continue;
      if (job.status === 'running' || job.status === 'interrupted') {
        protectedJobs.push({ id: job.id, reason: `Job is ${job.status}.` });
      } else if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime()) {
        protectedJobs.push({ id: job.id, reason: 'A retry is still pending.' });
      } else {
        candidates.push(job.id);
      }
    }

    const removed: string[] = [];
    if (apply) {
      for (const id of candidates) {
        await rm(path(loaded, id));
        removed.push(id);
      }
    }
    return { project, beforeDate, dryRun: !apply, candidates, protectedJobs, removed };
  });
}

export async function tick(loaded: LoadedConfig, projectId: string, options: ProcessOptions, operations: SchedulerOperations = defaults): Promise<{ readonly project: string; readonly healthy: boolean; readonly jobs: readonly Job[] }> {
  const project = selectProject(loaded.config, projectId);
  const schedule = project.schedule;
  if (!schedule) throw new WitnessError('This project has no schedule.');
  // A separate scheduler lock covers state transitions; operations keep their existing project locks.
  return withProjectLock(loaded.storageDirectory, schedulerLock(projectId), async () => {
    await mkdir(directory(loaded), { recursive: true, mode: 0o700 });
    const now = operations.now();
    const local = localDate(now, schedule.timeZone);
    const results: Job[] = [];
    // Interrupted work blocks subsequent slots until an operator acknowledges it.
    for (const job of await listJobs(loaded, projectId)) {
      if (job.status === 'running' || job.status === 'interrupted') {
        const interrupted: Job = { ...job, status: 'interrupted', updatedAt: now.toISOString(), error: 'Previous execution was interrupted. Inspect project locks and artifacts, then recover-job.' };
        await saveJob(loaded, interrupted);
        return { project: projectId, healthy: false, jobs: [interrupted] };
      }
    }
    for (const kind of ['backup', 'verify'] as const) {
      const at = kind === 'backup' ? schedule.backupAt : schedule.verifyAt;
      if (!at || local.minutes < scheduledMinutes(at)) continue;
      const id = `${projectId}-${kind}-${local.date}`;
      let job = await loadJob(loaded, id);
      if (job && job.timeZone !== schedule.timeZone) throw new WitnessError('Schedule timezone changed within an existing slot. Inspect job history.');
      if (job?.status === 'succeeded' || job?.status === 'abandoned' || (job && job.attempts >= schedule.maxAttempts) || (job?.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime())) {
        if (job) results.push(job);
        continue;
      }
      if (options.signal?.aborted) throw new WitnessError('Scheduled operation cancelled.');
      job = { ...(job ?? { version: 1, id, project: projectId, kind, slot: local.date, timeZone: schedule.timeZone, uploaded: false }),
        status: 'running', attempts: (job?.attempts ?? 0) + 1, updatedAt: now.toISOString() };
      // Record intent before effects. A hard stop leaves an explicit interrupted job.
      await saveJob(loaded, job);
      try {
        if (kind === 'backup') {
          if (!job.backupId) {
            const manifest = await operations.backup(loaded, projectId, options);
            job = { ...job, backupId: manifest.id, updatedAt: operations.now().toISOString() };
            await saveJob(loaded, job);
          }
          const recorded = await loadManifest(loaded.storageDirectory, job.backupId ?? '');
          if (recorded.project !== projectId || recorded.environment !== project.environment) throw new WitnessError('Scheduled backup identity differs from current project.');
          if (schedule.upload && !job.uploaded) {
            await operations.push(loaded, job.backupId ?? '', options);
            job = { ...job, uploaded: true };
            await saveJob(loaded, job);
          }
        } else {
          if (!job.backupId) {
            const latest = (await listBackups(loaded.storageDirectory, projectId))[0];
            if (!latest) throw new WitnessError('No local backup is available for scheduled verification.');
            if (latest.environment !== project.environment) throw new WitnessError('Backup environment differs from current project.');
            job = { ...job, backupId: latest.id };
            await saveJob(loaded, job);
          }
          const recorded = await loadManifest(loaded.storageDirectory, job.backupId ?? '');
          if (recorded.project !== projectId || recorded.environment !== project.environment) throw new WitnessError('Scheduled verification identity differs from current project.');
          const report = await operations.verify(loaded, job.backupId ?? '', options);
          if (!report.passed) throw new WitnessError('Scheduled restore verification failed. Inspect verification report.');
        }
        const { error: _error, nextAttemptAt: _next, ...completed } = job;
        job = { ...completed, status: 'succeeded', updatedAt: operations.now().toISOString() };
      } catch (error) {
        const finished = operations.now();
        job = { ...job, status: 'failed', updatedAt: finished.toISOString(), error: safeMessage(error), nextAttemptAt: new Date(finished.getTime() + schedule.retryDelaySeconds * 1000).toISOString() };
      }
      await saveJob(loaded, job);
      results.push(job);
    }
    return { project: projectId, healthy: results.every((job) => job.status === 'succeeded'), jobs: results };
  });
}

export async function recoverJob(loaded: LoadedConfig, id: string, now = new Date()): Promise<Job> {
  const job = await loadJob(loaded, id);
  if (!job) throw new WitnessError('Job was not found.');
  selectProject(loaded.config, job.project);
  return withProjectLock(loaded.storageDirectory, schedulerLock(job.project), async () => {
    const current = await loadJob(loaded, id);
    if (!current || !['running', 'interrupted'].includes(current.status)) throw new WitnessError('Only interrupted/running jobs can be recovered.');
    // Acknowledge rather than replay uncertain effects. The next calendar slot may proceed.
    const { nextAttemptAt: _next, ...fields } = current;
    const recovered: Job = { ...fields, status: 'abandoned', updatedAt: now.toISOString(), error: 'Interruption acknowledged by operator; this slot will not be replayed.' };
    await saveJob(loaded, recovered);
    return recovered;
  });
}
