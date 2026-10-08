import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type LoadedConfig } from '../src/config.js';
import { monitor } from '../src/monitoring.js';
import { monitorAndNotify } from '../src/notifications.js';
import { atomicJson, type Manifest } from '../src/storage.js';
import { runCommand } from '../src/commands.js';

const roots: string[] = []; const servers: Server[] = [];
const now = new Date('2026-10-07T08:00:00Z');
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  delete process.env.RW_TEST_WEBHOOK; delete process.env.RW_TEST_BEARER;
});
async function fixture(): Promise<LoadedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'rw-monitor-')); roots.push(root);
  return { storageDirectory: root, postgresBinDirectory: undefined, config: configSchema.parse({ version: 1, projects: {
    example: { environment: 'test', connectionEnv: 'NEVER_CONNECT', monitoring: { maximumBackupAgeSeconds: 3600, maximumVerificationAgeSeconds: 7200 },
      notification: { webhookUrlEnv: 'RW_TEST_WEBHOOK', bearerTokenEnv: 'RW_TEST_BEARER', allowInsecureLocalEndpoint: true, timeoutSeconds: 1, retryDelaySeconds: 1 } },
  } }) };
}
async function artifact(loaded: LoadedConfig, createdAt = now.toISOString(), verifiedAt: string | null = createdAt, passed = true): Promise<Manifest> {
  const bytes = Buffer.from('synthetic monitoring test, not a PostgreSQL archive');
  const item: Manifest = { version: 1, format: 'postgres-custom', id: randomUUID(), project: 'example', environment: 'test', createdAt,
    serverMajor: 16, sourceFingerprint: '0'.repeat(64), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), assertions: [] };
  const directory = join(loaded.storageDirectory, item.id); await mkdir(directory); await writeFile(join(directory, 'backup.dump'), bytes);
  await atomicJson(join(directory, 'manifest.json'), item);
  if (verifiedAt) await atomicJson(join(directory, 'verification.json'), { version: 1, backupId: item.id, project: item.project, verifiedAt, durationMs: 1, passed,
    checks: [{ name: 'fixture', passed, detail: 'Synthetic unit observation' }] });
  return item;
}
interface Received { readonly body: string; readonly id: string | undefined; readonly authorization: string | undefined }
async function receiver(handler: (request: Received, response: import('node:http').ServerResponse) => void): Promise<Received[]> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const item = { body, id: request.headers['idempotency-key'] as string | undefined, authorization: request.headers.authorization };
      received.push(item); handler(item, response);
    });
  }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test receiver');
  process.env.RW_TEST_WEBHOOK = `http://127.0.0.1:${address.port}/hook?test-secret=hidden`;
  process.env.RW_TEST_BEARER = 'synthetic-private-token';
  return received;
}
const codes = async (loaded: LoadedConfig): Promise<readonly string[]> => (await monitor(loaded, 'example', undefined, now)).alerts.map((alert) => alert.code);

describe('local recovery monitoring', () => {
  it('rejects old verified data even when its verification is fresh and a new unverified backup exists', async () => {
    const loaded = await fixture();
    const old = await artifact(loaded, '2026-09-30T08:00:00Z', now.toISOString());
    await artifact(loaded, now.toISOString(), null);
    const report = await monitor(loaded, 'example', undefined, now);
    expect(report).toMatchObject({ healthy: false, backupAgeSeconds: 0, verificationAgeSeconds: 0, verifiedBackupAgeSeconds: 7 * 86400, latestVerifiedBackupId: old.id });
    expect(report.alerts).toContainEqual({ code: 'verified-backup-stale', subject: old.id });
  });
  it('uses snapshot start and picks the newest verified data rather than the latest recheck of old data', async () => {
    const loaded = await fixture();
    const latest = await artifact(loaded, '2026-10-07T07:30:00Z', '2026-10-07T07:45:00Z');
    await artifact(loaded, '2026-09-30T08:00:00Z', now.toISOString());
    await atomicJson(join(loaded.storageDirectory, latest.id, 'manifest.json'), { ...latest, snapshotStartedAt: '2026-10-06T07:00:00Z' });
    expect((await monitor(loaded, 'example', undefined, now)).verifiedBackupAgeSeconds).toBe(90000);
    loaded.config.projects.example!.monitoring!.maximumVerifiedBackupAgeSeconds = 90000;
    expect((await monitor(loaded, 'example', undefined, now)).healthy).toBe(true);
  });
  it('reports missing and stale recovery points, with independent age thresholds', async () => {
    const loaded = await fixture(); expect(await codes(loaded)).toEqual(['backup-missing', 'verification-missing']);
    await artifact(loaded, '2026-10-07T06:59:59Z', '2026-10-07T05:59:59Z');
    expect(await codes(loaded)).toEqual(['backup-stale', 'verification-stale']);
    const report = await monitor(loaded, 'example', undefined, now); expect(report.backupAgeSeconds).toBe(3601); expect(report.verificationAgeSeconds).toBe(7201);
  });
  it('accepts the exact age boundary and checks integrity without connecting to a database', async () => {
    const loaded = await fixture(); const item = await artifact(loaded, '2026-10-07T07:00:00Z', '2026-10-07T06:00:00Z');
    expect((await monitor(loaded, 'example', undefined, now)).healthy).toBe(true);
    await writeFile(join(loaded.storageDirectory, item.id, 'backup.dump'), 'corrupt');
    expect(await codes(loaded)).toEqual(['artifact-invalid']);
  });
  it('reports failed latest verification, mixed environment metadata, and invalid reports separately', async () => {
    const loaded = await fixture(); await artifact(loaded, '2026-10-07T07:00:00Z');
    const bad = await artifact(loaded, now.toISOString(), now.toISOString(), false);
    expect(await codes(loaded)).toEqual(['verification-failed']);
    await atomicJson(join(loaded.storageDirectory, bad.id, 'manifest.json'), { ...bad, environment: 'production' });
    expect(await codes(loaded)).toEqual(['environment-mismatch']);
    await atomicJson(join(loaded.storageDirectory, bad.id, 'manifest.json'), bad);
    await writeFile(join(loaded.storageDirectory, bad.id, 'verification.json'), '{}');
    expect(await codes(loaded)).toEqual(['verification-metadata-invalid']);
  });
  it('distinguishes interrupted/overdue jobs from normally running jobs and historical failures', async () => {
    const loaded = await fixture(); await artifact(loaded); const directory = join(loaded.storageDirectory, 'jobs'); await mkdir(directory);
    async function job(slot: string, kind: 'backup' | 'verify', status: 'running' | 'failed' | 'succeeded' | 'interrupted', updatedAt: string): Promise<void> {
      const id = `example-${kind}-${slot}`;
      await atomicJson(join(directory, `${id}.json`), { version: 1, id, project: 'example', kind, slot, timeZone: 'UTC', status, attempts: 1, updatedAt, uploaded: false,
        ...(status === 'succeeded' ? { backupId: randomUUID() } : {}) });
    }
    await job('2026-10-06', 'backup', 'failed', '2026-10-06T08:00:00Z');
    await job('2026-10-07', 'backup', 'succeeded', now.toISOString());
    await job('2026-10-07', 'verify', 'running', now.toISOString()); expect(await codes(loaded)).toEqual([]);
    await job('2026-10-07', 'verify', 'running', '2026-10-07T07:54:00Z'); expect(await codes(loaded)).toEqual(['job-overdue']);
    await job('2026-10-07', 'verify', 'interrupted', now.toISOString()); expect(await codes(loaded)).toEqual(['job-interrupted']);
    await job('2026-10-07', 'verify', 'failed', now.toISOString()); expect(await codes(loaded)).toEqual(['job-failed']);
    loaded.config.projects.example!.schedule = { timeZone: 'UTC', backupAt: '00:00', upload: false, maxAttempts: 1, retryDelaySeconds: 60 };
    expect(await codes(loaded)).toEqual(['job-failed', 'job-retry-exhausted']);
  });
  it('fails closed on corrupted catalogs, future clocks, disk limits, and cancellation', async () => {
    const loaded = await fixture(); const item = await artifact(loaded, '2026-10-07T08:02:00Z'); expect(await codes(loaded)).toEqual(['clock-future']);
    loaded.config.minimumFreeBytes = Number.MAX_SAFE_INTEGER; expect(await codes(loaded)).toEqual(['clock-future', 'disk-low']);
    await writeFile(join(loaded.storageDirectory, item.id, 'manifest.json'), '{}'); expect(await codes(loaded)).toEqual(['catalog-unavailable', 'disk-low', 'storage-usage-unavailable']);
    await expect(monitor(loaded, 'example', AbortSignal.abort(), now)).rejects.toThrow('cancelled');
  });
  it('exposes JSON failure status and requires explicit --notify on the monitor command', async () => {
    const loaded = await fixture(); const path = join(loaded.storageDirectory, 'config.json'); await atomicJson(path, { ...loaded.config, storageDirectory: loaded.storageDirectory });
    const result = await runCommand(['monitor', 'example', '--config', path], 'test'); expect(result.exitCode).toBe(1); expect(JSON.parse(result.stdout).healthy).toBe(false);
    expect((await runCommand(['backup', 'example', '--notify'], 'test')).exitCode).toBe(2);
  });
});

describe('durable opt-in webhook delivery', () => {
  it('sends one alert per changed state, suppresses growing ages, and delivers recovery once', async () => {
    const loaded = await fixture(); const requests = await receiver((_request, response) => { response.writeHead(204); response.end(); });
    const first = await monitorAndNotify(loaded, 'example', undefined, now); expect(first.notification.status).toBe('delivered');
    expect((await monitorAndNotify(loaded, 'example', undefined, new Date(now.getTime() + 1000))).notification.status).toBe('unchanged');
    await artifact(loaded);
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('delivered');
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('unchanged');
    expect(requests).toHaveLength(2); expect(JSON.parse(requests[0]!.body)).toMatchObject({ healthy: false, id: requests[0]!.id });
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ healthy: true, alerts: [] });
    expect(requests[0]!.authorization).toBe('Bearer synthetic-private-token');
    const state = await readFile(join(loaded.storageDirectory, 'notifications', 'example.json'), 'utf8');
    for (const secret of ['hidden', 'synthetic-private-token', 'NEVER_CONNECT', 'test-secret', 'sha256', 'RW_TEST_BEARER']) { expect(state).not.toContain(secret); expect(requests[0]!.body).not.toContain(secret); }
  });
  it('suppresses the same stale backup condition as ages increase and resends to a newly selected endpoint', async () => {
    const loaded = await fixture(); await artifact(loaded, '2026-10-07T06:00:00Z', '2026-10-07T05:00:00Z');
    const first = await receiver((_request, response) => { response.writeHead(204); response.end(); });
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('delivered');
    expect((await monitorAndNotify(loaded, 'example', undefined, new Date(now.getTime() + 100_000))).notification.status).toBe('unchanged'); expect(first).toHaveLength(1);
    const second = await receiver((_request, response) => { response.writeHead(204); response.end(); });
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('delivered'); expect(second).toHaveLength(1);
    expect(first[0]!.id).not.toBe(second[0]!.id);
  });
  it('serializes concurrent notification invocations so one active event is delivered', async () => {
    const loaded = await fixture(); let unblock: () => void = () => undefined; let started: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const requests = await receiver((_request, response) => { unblock = () => { response.writeHead(204); response.end(); }; started(); });
    const first = monitorAndNotify(loaded, 'example', undefined, now); await requestStarted;
    try { await expect(monitorAndNotify(loaded, 'example', undefined, now)).rejects.toThrow('locked'); }
    finally { unblock(); }
    expect((await first).notification.status).toBe('delivered'); expect(requests).toHaveLength(1);
  });
  it('does not send an initial healthy message and does not send without --notify', async () => {
    const loaded = await fixture(); await artifact(loaded); const requests = await receiver((_request, response) => response.end());
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('initial-healthy'); expect(requests).toHaveLength(0);
    const path = join(loaded.storageDirectory, 'config.json'); await atomicJson(path, { ...loaded.config, storageDirectory: loaded.storageDirectory });
    await runCommand(['monitor', 'example', '--config', path], 'test'); expect(requests).toHaveLength(0);
  });
  it('retries the exact persisted event only after backoff and suppresses it after acknowledgment', async () => {
    const loaded = await fixture(); let fail = true;
    const requests = await receiver((_request, response) => { response.writeHead(fail ? 503 : 204); response.end('receiver-private-error'); });
    const first = await monitorAndNotify(loaded, 'example', undefined, now); expect(first.notification.status).toBe('failed');
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('retry-pending'); expect(requests).toHaveLength(1);
    fail = false; const second = await monitorAndNotify(loaded, 'example', undefined, new Date(now.getTime() + 1001));
    expect(second.notification).toMatchObject({ status: 'delivered', eventId: first.notification.eventId }); expect(requests[0]!.body).toBe(requests[1]!.body);
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('unchanged');
  });
  it('does not follow redirects and keeps canceled or timed-out delivery pending without exposing endpoints', async () => {
    const loaded = await fixture(); const requests = await receiver((_request, response) => { response.writeHead(307, { location: 'http://127.0.0.1:1/leak' }); response.end(); });
    expect((await monitorAndNotify(loaded, 'example', undefined, now)).notification.status).toBe('failed'); expect(requests).toHaveLength(1);
    const result = await monitorAndNotify(loaded, 'example', AbortSignal.abort(), now).catch((error: unknown) => String(error));
    expect(result).toContain('cancelled'); expect(requests).toHaveLength(1);
  });
  it('times out stalled delivery and sends the latest recovery rather than an obsolete pending alert', async () => {
    const loaded = await fixture(); let stall = true;
    const requests = await receiver((_request, response) => { if (!stall) { response.writeHead(204); response.end(); } });
    const first = await monitorAndNotify(loaded, 'example', undefined, now); expect(first.notification.status).toBe('failed');
    await artifact(loaded); stall = false;
    const recovered = await monitorAndNotify(loaded, 'example', undefined, now); expect(recovered.notification.status).toBe('delivered');
    expect(recovered.notification.eventId).not.toBe(first.notification.eventId); expect(JSON.parse(requests[1]!.body).healthy).toBe(true);
  });
  it('rejects insecure endpoints, missing tokens and corrupt state before network delivery', async () => {
    const loaded = await fixture(); process.env.RW_TEST_WEBHOOK = 'http://example.com/private-secret'; process.env.RW_TEST_BEARER = 'test';
    await expect(monitorAndNotify(loaded, 'example', undefined, now)).rejects.toThrow('requires HTTPS');
    const requests = await receiver((_request, response) => response.end()); delete process.env.RW_TEST_BEARER;
    await expect(monitorAndNotify(loaded, 'example', undefined, now)).rejects.toThrow('token environment'); expect(requests).toHaveLength(0);
    process.env.RW_TEST_BEARER = 'test'; await mkdir(join(loaded.storageDirectory, 'notifications'));
    await writeFile(join(loaded.storageDirectory, 'notifications', 'example.json'), '{}');
    await expect(monitorAndNotify(loaded, 'example', undefined, now)).rejects.toThrow('Invalid notification state'); expect(requests).toHaveLength(0);
  });
});
