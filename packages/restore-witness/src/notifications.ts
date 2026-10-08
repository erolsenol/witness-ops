import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { selectProject, projectId, type LoadedConfig } from './config.js';
import { WitnessError } from './errors.js';
import { alertCodes, monitor, type MonitorReport } from './monitoring.js';
import { atomicJson, readJson, withProjectLock } from './storage.js';

const eventSchema = z.strictObject({
  version: z.literal(1), id: z.string().uuid(), project: projectId, observedAt: z.string().datetime(), healthy: z.boolean(),
  alerts: z.array(z.strictObject({ code: z.enum(alertCodes), subject: z.string().max(200).optional() })).max(4000),
});
const receiptSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), endpointHash: z.string().regex(/^[a-f0-9]{64}$/), healthy: z.boolean() });
const stateSchema = z.strictObject({
  version: z.literal(1), project: projectId,
  acknowledged: receiptSchema.optional(),
  pending: z.strictObject({ receipt: receiptSchema, event: eventSchema, nextAttemptAt: z.string().datetime().optional() }).optional(),
});
type NotificationState = z.infer<typeof stateSchema>;
export interface NotificationResult {
  readonly status: 'delivered' | 'unchanged' | 'initial-healthy' | 'failed' | 'retry-pending';
  readonly eventId?: string;
}
export interface NotifiedReport {
  readonly report: MonitorReport;
  readonly notification: NotificationResult;
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

function endpointFromEnv(name: string, allowLocal: boolean): URL {
  const value = process.env[name];
  let url: URL;
  try { if (!value) throw new Error('Missing'); url = new URL(value); }
  catch { throw new WitnessError('Webhook URL environment reference is missing or invalid.'); }
  const localHttp = allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) throw new WitnessError('Webhook URL requires HTTPS without user credentials or fragment; explicit loopback HTTP is permitted for tests.');
  return url;
}
async function loadState(path: string, project: string): Promise<NotificationState> {
  const exists = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) return { version: 1, project };
  const parsed = stateSchema.safeParse(await readJson(path));
  const pending = parsed.success ? parsed.data.pending : undefined;
  if (!parsed.success || parsed.data.project !== project || (pending && (pending.event.project !== project
    || pending.receipt.healthy !== pending.event.healthy || pending.event.healthy !== (pending.event.alerts.length === 0)
    || pending.receipt.fingerprint !== hash(JSON.stringify(pending.event.alerts))))) throw new WitnessError('Invalid notification state. Inspect state before retrying.');
  return parsed.data;
}

export async function monitorAndNotify(loaded: LoadedConfig, project: string, signal?: AbortSignal, now = new Date()): Promise<NotifiedReport> {
  const config = selectProject(loaded.config, project).notification;
  if (!config) throw new WitnessError('Notifications are not configured for this project.');
  const endpoint = endpointFromEnv(config.webhookUrlEnv, config.allowInsecureLocalEndpoint);
  const token = config.bearerTokenEnv ? process.env[config.bearerTokenEnv] : undefined;
  if (config.bearerTokenEnv && (!token || /[\r\n]/.test(token))) throw new WitnessError('Webhook bearer token environment reference is missing or invalid.');
  return withProjectLock(loaded.storageDirectory, `notify-${hash(project).slice(0, 32)}`, async () => {
    const directory = join(loaded.storageDirectory, 'notifications');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${project}.json`);
    const state = await loadState(path, project);
    const report = await monitor(loaded, project, signal, now);
    const fingerprint = hash(JSON.stringify(report.alerts));
    const endpointHash = hash(endpoint.href);
    const same = (receipt: z.infer<typeof receiptSchema> | undefined): boolean => receipt?.fingerprint === fingerprint && receipt.endpointHash === endpointHash;
    if (!state.pending && same(state.acknowledged)) return { report, notification: { status: 'unchanged' } };
    // Recover after an unacknowledged alert too: a receiver may have accepted it before the client timed out.
    if (report.healthy && state.acknowledged?.healthy !== false && !state.pending) return { report, notification: { status: 'initial-healthy' } };
    if (state.pending && same(state.pending.receipt) && state.pending.nextAttemptAt && Date.parse(state.pending.nextAttemptAt) > now.getTime()) {
      return { report, notification: { status: 'retry-pending', eventId: state.pending.event.id } };
    }
    const pending: NonNullable<NotificationState['pending']> = state.pending && same(state.pending.receipt) ? state.pending : {
      receipt: { fingerprint, endpointHash, healthy: report.healthy },
      event: { version: 1 as const, id: randomUUID(), project, observedAt: report.observedAt, healthy: report.healthy, alerts: [...report.alerts] },
    };
    const next: NotificationState = { ...state, pending };
    // Persist event ID and immutable payload before delivery for receiver-side deduplication.
    await atomicJson(path, stateSchema.parse(next));
    const deadline = AbortSignal.timeout(config.timeoutSeconds * 1000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const failed = async (): Promise<NotifiedReport> => {
      await atomicJson(path, { ...next, pending: { ...pending, nextAttemptAt: new Date(now.getTime() + config.retryDelaySeconds * 1000).toISOString() } });
      return { report, notification: { status: 'failed', eventId: pending.event.id } };
    };
    let accepted = false;
    try {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: requestSignal,
        headers: { 'content-type': 'application/json', 'idempotency-key': pending.event.id, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(pending.event),
      });
      await response.body?.cancel();
      accepted = response.ok;
    } catch { accepted = false; }
    if (!accepted) return failed();
    await atomicJson(path, { version: 1, project, acknowledged: pending.receipt });
    return { report, notification: { status: 'delivered', eventId: pending.event.id } };
  });
}
