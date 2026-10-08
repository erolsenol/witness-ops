import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDate } from '../src/calendar.js';
import { configSchema, type LoadedConfig } from '../src/config.js';
import { WitnessError } from '../src/errors.js';
import { evaluateRetention, prune } from '../src/retention.js';
import { compactJobs, listJobs, recoverJob, tick, type SchedulerOperations } from '../src/scheduler.js';
import { atomicJson, listBackups, type Manifest, type VerificationReport } from '../src/storage.js';
import { runCommand } from '../src/commands.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const options = { timeoutMs: 10_000 };
async function fixture(): Promise<LoadedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'rw-automation-')); roots.push(root);
  return { storageDirectory: root, postgresBinDirectory: undefined, config: configSchema.parse({ version: 1, projects: {
    example: { environment: 'test', connectionEnv: 'UNUSED_DB', schedule: { timeZone: 'America/New_York', backupAt: '01:30', verifyAt: '01:30', retryDelaySeconds: 60 }, retention: { daily: 1, weekly: 0, monthly: 0 } },
  } }) };
}
async function artifact(loaded: LoadedConfig, at: string): Promise<Manifest> {
  const bytes = Buffer.from('unit test artifact, not a database dump');
  const manifest: Manifest = { version: 1, format: 'postgres-custom', id: randomUUID(), project: 'example', environment: 'test', createdAt: at,
    serverMajor: 16, sourceFingerprint: '0'.repeat(64), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), assertions: [] };
  const directory = join(loaded.storageDirectory, manifest.id);
  await mkdir(directory); await writeFile(join(directory, 'backup.dump'), bytes);
  await atomicJson(join(directory, 'manifest.json'), manifest);
  return manifest;
}
function report(manifest: Manifest, passed = true): VerificationReport {
  return { version: 1, project: manifest.project, backupId: manifest.id, passed, verifiedAt: manifest.createdAt, durationMs: 1, checks: [{ name: 'fixture', passed, detail: 'Synthetic unit fixture' }] };
}
function operations(loaded: LoadedConfig, clock: { value: string }): SchedulerOperations {
  return { now: () => new Date(clock.value), backup: vi.fn(async () => artifact(loaded, clock.value)), push: vi.fn(async () => undefined),
    verify: vi.fn(async (_config, id) => { const manifest = (await listBackups(loaded.storageDirectory, 'example')).find((item) => item.id === id); if (!manifest) throw new Error('Missing fixture'); return report(manifest); }) };
}

describe('daily scheduling and durable jobs', () => {
  it('runs backup before verify, persists success and does not rerun the repeated DST hour', async () => {
    const loaded = await fixture(); const clock = { value: '2026-11-01T05:31:00Z' }; const ops = operations(loaded, clock);
    expect((await tick(loaded, 'example', options, ops)).healthy).toBe(true);
    clock.value = '2026-11-01T06:31:00Z';
    expect((await tick(loaded, 'example', options, ops)).healthy).toBe(true);
    expect(ops.backup).toHaveBeenCalledTimes(1); expect(ops.verify).toHaveBeenCalledTimes(1);
    expect((await listJobs(loaded, 'example')).map((job) => job.status)).toEqual(['succeeded', 'succeeded']);
    clock.value = '2026-11-02T06:31:00Z'; await tick(loaded, 'example', options, ops);
    expect(ops.backup).toHaveBeenCalledTimes(2);
  });
  it('catches up a skipped spring DST time once, and waits before due time', async () => {
    const loaded = await fixture(); loaded.config.projects.example!.schedule!.backupAt = '02:30';
    delete loaded.config.projects.example!.schedule!.verifyAt;
    const clock = { value: '2026-03-08T06:59:00Z' }; const ops = operations(loaded, clock);
    expect((await tick(loaded, 'example', options, ops)).jobs).toEqual([]);
    clock.value = '2026-03-08T07:00:00Z'; await tick(loaded, 'example', options, ops);
    await tick(loaded, 'example', options, ops); expect(ops.backup).toHaveBeenCalledTimes(1);
    expect(localDate(new Date(clock.value), 'America/New_York')).toEqual({ date: '2026-03-08', minutes: 180 });
  });
  it('retries failed upload using the already recorded backup, after backoff', async () => {
    const loaded = await fixture(); loaded.config.projects.example!.schedule!.upload = true;
    delete loaded.config.projects.example!.schedule!.verifyAt;
    const clock = { value: '2026-11-02T07:00:00Z' }; const ops = operations(loaded, clock);
    const push = vi.fn().mockRejectedValueOnce(new WitnessError('Temporary upload failure')).mockResolvedValue(undefined);
    const configured = { ...ops, push };
    expect((await tick(loaded, 'example', options, configured)).healthy).toBe(false);
    await tick(loaded, 'example', options, configured); expect(push).toHaveBeenCalledTimes(1);
    clock.value = '2026-11-02T07:01:01Z';
    expect((await tick(loaded, 'example', options, configured)).healthy).toBe(true);
    expect(ops.backup).toHaveBeenCalledTimes(1); expect(push).toHaveBeenCalledTimes(2);
    const [job] = await listJobs(loaded, 'example'); expect(job).toMatchObject({ attempts: 2, uploaded: true, status: 'succeeded' }); expect(job).not.toHaveProperty('error');
  });
  it('limits retries and reports failed verification without claiming success', async () => {
    const loaded = await fixture(); const clock = { value: '2026-11-02T07:00:00Z' }; const ops = operations(loaded, clock);
    const verify = vi.fn(async (_loaded: LoadedConfig, id: string) => ({ ...report((await listBackups(loaded.storageDirectory, 'example'))[0]!), backupId: id, passed: false }));
    for (let index = 0; index < 5; index++) { clock.value = `2026-11-02T07:0${index}:00Z`; expect((await tick(loaded, 'example', options, { ...ops, verify })).healthy).toBe(false); }
    expect(verify).toHaveBeenCalledTimes(3); expect(ops.backup).toHaveBeenCalledTimes(1);
  });
  it('quarantines interrupted work across days and only acknowledges it under an explicit recovery command', async () => {
    const loaded = await fixture(); const clock = { value: '2026-11-02T07:00:00Z' }; const ops = operations(loaded, clock);
    await mkdir(join(loaded.storageDirectory, 'jobs'));
    const id = 'example-backup-2026-11-01';
    await atomicJson(join(loaded.storageDirectory, 'jobs', `${id}.json`), { version: 1, id, project: 'example', kind: 'backup', slot: '2026-11-01', timeZone: 'America/New_York', status: 'running', attempts: 1, updatedAt: '2026-11-01T07:00:00Z', uploaded: false });
    expect((await tick(loaded, 'example', options, ops)).jobs[0]?.status).toBe('interrupted'); expect(ops.backup).not.toHaveBeenCalled();
    expect(await recoverJob(loaded, id)).toMatchObject({ status: 'abandoned', attempts: 1 });
    await expect(recoverJob(loaded, id)).rejects.toThrow('Only interrupted');
    expect((await tick(loaded, 'example', options, ops)).healthy).toBe(true);
  });
  it('rejects corrupted history, invalid schedules, and unsafe credential-free scheduled uploads', async () => {
    const loaded = await fixture(); await mkdir(join(loaded.storageDirectory, 'jobs'));
    await writeFile(join(loaded.storageDirectory, 'jobs', 'example-backup-2026-11-02.json'), '{}');
    await expect(tick(loaded, 'example', options, operations(loaded, { value: '2026-11-02T07:00:00Z' }))).rejects.toThrow('Invalid job');
    for (const schedule of [{ timeZone: 'Invalid/Zone', backupAt: '01:00' }, { timeZone: 'UTC', backupAt: '24:00' }, { timeZone: 'UTC', backupAt: '01:00', upload: true }]) {
      expect(configSchema.safeParse({ version: 1, projects: { example: { environment: 'test', connectionEnv: 'DB', schedule } } }).success).toBe(false);
    }
    await expect(recoverJob(loaded, '../escape')).rejects.toThrow('Invalid job');
  });
  it('serializes concurrent ticks and blocks recovery while a job is actively running', async () => {
    const loaded = await fixture(); const clock = { value: '2026-11-02T07:00:00Z' }; const ops = operations(loaded, clock);
    let markStarted: () => void = () => undefined; let unblock: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const controlled = { ...ops, backup: async () => { markStarted(); await blocked; return artifact(loaded, clock.value); } };
    const first = tick(loaded, 'example', options, controlled);
    await started;
    try {
      await expect(tick(loaded, 'example', options, ops)).rejects.toThrow('locked');
      await expect(recoverJob(loaded, 'example-backup-2026-11-02')).rejects.toThrow('locked');
    } finally { unblock(); }
    expect((await first).healthy).toBe(true);
  });
  it('accepts the longest configured project identifier without an invalid scheduler lock', async () => {
    const loaded = await fixture(); const id = 'p'.repeat(63);
    loaded.config.projects = { [id]: loaded.config.projects.example! };
    const ops = operations(loaded, { value: '2026-11-02T05:00:00Z' });
    expect((await tick(loaded, id, options, ops)).jobs).toEqual([]);
  });
  it('honors cancellation before starting effects', async () => {
    const loaded = await fixture(); const ops = operations(loaded, { value: '2026-11-02T07:00:00Z' });
    await expect(tick(loaded, 'example', { ...options, signal: AbortSignal.abort() }, ops)).rejects.toThrow('cancelled'); expect(ops.backup).not.toHaveBeenCalled();
  });

  it('previews and compacts only old terminal job history while protecting active and retryable jobs', async () => {
    const loaded = await fixture(); const jobsDirectory = join(loaded.storageDirectory, 'jobs');
    await mkdir(jobsDirectory);
    const now = new Date('2026-02-01T00:00:00.000Z');
    async function saveJob(slot: string, kind: 'backup' | 'verify', status: 'running' | 'interrupted' | 'failed' | 'succeeded' | 'abandoned', extra: Record<string, unknown> = {}): Promise<string> {
      const id = `example-${kind}-${slot}`;
      await atomicJson(join(jobsDirectory, `${id}.json`), {
        version: 1, id, project: 'example', kind, slot, timeZone: 'UTC', status,
        attempts: 1, updatedAt: `${slot}T00:00:00.000Z`, uploaded: false,
        ...(status === 'succeeded' ? { backupId: randomUUID() } : {}), ...extra,
      });
      return id;
    }
    const succeeded = await saveJob('2025-01-01', 'backup', 'succeeded');
    const abandoned = await saveJob('2025-02-01', 'verify', 'abandoned');
    const expiredFailure = await saveJob('2025-03-01', 'backup', 'failed', { nextAttemptAt: '2025-03-01T00:01:00.000Z' });
    const interrupted = await saveJob('2025-04-01', 'verify', 'interrupted');
    const running = await saveJob('2025-05-01', 'backup', 'running');
    const retryPending = await saveJob('2025-06-01', 'verify', 'failed', { nextAttemptAt: '2026-02-02T00:00:00.000Z' });
    const recent = await saveJob('2026-01-01', 'backup', 'succeeded');

    const preview = await compactJobs(loaded, 'example', '2026-01-01', false, now);
    expect(preview).toMatchObject({ dryRun: true, candidates: [expiredFailure, abandoned, succeeded], removed: [] });
    expect(preview.protectedJobs).toEqual([
      { id: retryPending, reason: 'A retry is still pending.' },
      { id: running, reason: 'Job is running.' },
      { id: interrupted, reason: 'Job is interrupted.' },
    ]);
    expect((await listJobs(loaded, 'example'))).toHaveLength(7);

    const applied = await compactJobs(loaded, 'example', '2026-01-01', true, now);
    expect(applied).toMatchObject({ dryRun: false, candidates: [expiredFailure, abandoned, succeeded], removed: [expiredFailure, abandoned, succeeded] });
    expect((await listJobs(loaded, 'example')).map((job) => job.id).sort()).toEqual([interrupted, recent, retryPending, running].sort());
  });

  it('rejects an invalid job-history cutoff without changing history', async () => {
    const loaded = await fixture();
    await expect(compactJobs(loaded, 'example', '2026-02-30', true)).rejects.toThrow('Invalid job history cutoff');
    await expect(compactJobs(loaded, 'example', '2099-01-01', true, new Date('2026-02-01T00:00:00.000Z'))).rejects.toThrow('cannot be in the future');
  });
});

describe('local retention safety', () => {
  it('keeps newest representatives of calendar days, Monday weeks and months plus protected recovery points', async () => {
    const loaded = await fixture();
    const items = await Promise.all(['2026-01-01T23:00:00Z','2026-02-01T23:00:00Z','2026-02-08T23:00:00Z','2026-02-09T23:00:00Z','2026-02-10T22:00:00Z','2026-02-10T23:00:00Z'].map((at) => artifact(loaded, at)));
    const result = evaluateRetention(items, { timeZone: 'UTC', daily: 1, weekly: 2, monthly: 2 }, items[0]!.id);
    expect(result.keep.map((item) => item.backupId)).toEqual([items[5]!.id, items[2]!.id, items[0]!.id]);
    expect(result.remove).toHaveLength(3);
    const zero = evaluateRetention(items, { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 }, items[0]!.id);
    expect(zero.keep).toHaveLength(2);
  });
  it('defaults CLI prune to dry run, applies only candidates and preserves the newest verified point', async () => {
    const loaded = await fixture(); const old = await artifact(loaded, '2026-01-01T00:00:00Z'); const discard = await artifact(loaded, '2026-01-02T00:00:00Z'); const newest = await artifact(loaded, '2026-01-03T00:00:00Z');
    await atomicJson(join(loaded.storageDirectory, old.id, 'verification.json'), report(old));
    const configPath = join(loaded.storageDirectory, 'config.json'); await atomicJson(configPath, { ...loaded.config, storageDirectory: loaded.storageDirectory });
    const preview = await runCommand(['prune', 'example', '--config', configPath], 'test');
    expect(preview.exitCode).toBe(0); expect(JSON.parse(preview.stdout)).toMatchObject({ apply: false, scope: 'local', protectedVerifiedId: old.id, remove: [{ backupId: discard.id }], deleted: [] });
    expect(await listBackups(loaded.storageDirectory, 'example')).toHaveLength(3);
    const applied = await prune(loaded, 'example', true);
    expect(applied.deleted).toEqual([discard.id]); expect((await listBackups(loaded.storageDirectory, 'example')).map((item) => item.id)).toEqual([newest.id, old.id]);
  });
  it('protects artifacts needed by interrupted jobs and honors cancellation before deletion', async () => {
    const loaded = await fixture(); const old = await artifact(loaded, '2026-01-01T00:00:00Z'); const pending = await artifact(loaded, '2026-01-02T00:00:00Z'); await artifact(loaded, '2026-01-03T00:00:00Z');
    await atomicJson(join(loaded.storageDirectory, old.id, 'verification.json'), report(old));
    await mkdir(join(loaded.storageDirectory, 'jobs'));
    const id = 'example-backup-2026-01-02';
    await atomicJson(join(loaded.storageDirectory, 'jobs', `${id}.json`), { version: 1, id, project: 'example', kind: 'backup', slot: '2026-01-02', timeZone: 'UTC', status: 'interrupted', attempts: 1, updatedAt: '2026-01-02T00:00:00Z', backupId: pending.id, uploaded: false });
    const plan = await prune(loaded, 'example', false);
    expect(plan.remove).toEqual([]); expect(plan.keep.find((item) => item.backupId === pending.id)?.reasons).toContain('pending-job');
    await recoverJob(loaded, id);
    expect((await prune(loaded, 'example', false)).remove.map((item) => item.backupId)).toEqual([pending.id]);
    await expect(prune(loaded, 'example', true, AbortSignal.abort())).rejects.toThrow('cancelled');
    expect(await listBackups(loaded.storageDirectory, 'example')).toHaveLength(3);
  });
  it('blocks deletion without a verified recovery point and fails before deletion on corrupted artifacts', async () => {
    const loaded = await fixture(); const old = await artifact(loaded, '2026-01-01T00:00:00Z'); const newest = await artifact(loaded, '2026-01-02T00:00:00Z');
    expect((await prune(loaded, 'example', false)).blockedReason).toContain('No intact');
    await expect(prune(loaded, 'example', true)).rejects.toThrow('Retention blocked');
    await atomicJson(join(loaded.storageDirectory, newest.id, 'verification.json'), report(newest));
    await writeFile(join(loaded.storageDirectory, old.id, 'backup.dump'), 'corrupted');
    await expect(prune(loaded, 'example', true)).rejects.toThrow('checksum');
    expect(await readFile(join(loaded.storageDirectory, newest.id, 'backup.dump'))).toBeTruthy();
    expect(await listBackups(loaded.storageDirectory, 'example')).toHaveLength(2);
  });
  it('rejects mismatched environments, symlink artifacts and concurrent locks before removing files', async () => {
    const loaded = await fixture(); const old = await artifact(loaded, '2026-01-01T00:00:00Z'); const newest = await artifact(loaded, '2026-01-02T00:00:00Z');
    await atomicJson(join(loaded.storageDirectory, newest.id, 'verification.json'), report(newest));
    await atomicJson(join(loaded.storageDirectory, old.id, 'manifest.json'), { ...old, environment: 'production' });
    await expect(prune(loaded, 'example', true)).rejects.toThrow('different project environment');
    await atomicJson(join(loaded.storageDirectory, old.id, 'manifest.json'), old);
    await rm(join(loaded.storageDirectory, old.id, 'backup.dump')); await symlink(join(loaded.storageDirectory, newest.id, 'backup.dump'), join(loaded.storageDirectory, old.id, 'backup.dump'));
    await expect(prune(loaded, 'example', true)).rejects.toThrow('unsafe');
    await mkdir(join(loaded.storageDirectory, '.locks', 'example.lock'));
    await expect(prune(loaded, 'example', true)).rejects.toThrow('locked');
    expect((await readdir(loaded.storageDirectory)).filter((name) => name.startsWith('.pruned-'))).toEqual([]);
  });
});
