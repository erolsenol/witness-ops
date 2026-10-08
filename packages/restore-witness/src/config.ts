import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { WitnessError } from './errors.js';

export const projectId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const ageRecipient = z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/);
export const encryptionSchema = z.strictObject({
  recipient: ageRecipient,
  identityFileEnv: envName,
});
export const s3Schema = z.strictObject({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  region: z.string().regex(/^[a-z0-9-]{1,64}$/),
  endpoint: z.string().url().optional(),
  prefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,199}$/).default('restore-witness'),
  forcePathStyle: z.boolean().default(false),
  accessKeyEnv: envName,
  secretKeyEnv: envName,
  sessionTokenEnv: envName.optional(),
  allowInsecureLocalEndpoint: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (!value.endpoint) return;
  const url = new URL(value.endpoint);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && value.allowInsecureLocalEndpoint;
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    ctx.addIssue({ code: 'custom', message: 'S3 endpoint must be HTTPS; explicit loopback-only HTTP is allowed for tests.' });
  }
});
const identifier = z.string().min(1).max(63).refine((value) => !value.includes('\0'));
export const timeZoneSchema = z.string().max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
const dailyTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
export const scheduleSchema = z.strictObject({
  timeZone: timeZoneSchema,
  backupAt: dailyTime,
  verifyAt: dailyTime.optional(),
  upload: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  retryDelaySeconds: z.number().int().min(1).max(86400).default(300),
});
export const retentionSchema = z.strictObject({
  timeZone: timeZoneSchema.default('UTC'),
  daily: z.number().int().min(0).max(366).default(7),
  weekly: z.number().int().min(0).max(520).default(4),
  monthly: z.number().int().min(0).max(120).default(12),
});
export const monitoringSchema = z.strictObject({
  maximumBackupAgeSeconds: z.number().int().min(1).max(366 * 86400).default(86400),
  maximumVerificationAgeSeconds: z.number().int().min(1).max(366 * 86400).default(7 * 86400),
  maximumVerifiedBackupAgeSeconds: z.number().int().min(1).max(366 * 86400).default(86400),
});
export const notificationSchema = z.strictObject({
  webhookUrlEnv: envName,
  retryDelaySeconds: z.number().int().min(1).max(86400).default(60),
  bearerTokenEnv: envName.optional(),
  timeoutSeconds: z.number().int().min(1).max(30).default(10),
  allowInsecureLocalEndpoint: z.boolean().default(false),
});
export const sandboxResourcesSchema = z.strictObject({
  memoryMiB: z.number().int().min(256).max(65536).default(512),
  cpus: z.number().min(0.25).max(32).multipleOf(0.25).default(1),
  pidsLimit: z.number().int().min(32).max(4096).default(256),
});
export interface SandboxResources {
  readonly memoryMiB: number;
  readonly cpus: number;
  readonly pidsLimit: number;
}
export const projectSchema = z.strictObject({
  environment: z.enum(['development', 'test', 'staging', 'production']),
  connectionEnv: envName,
  assertions: z.array(z.strictObject({
    schema: identifier.default('public'),
    table: identifier,
    minimumRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(1),
  })).max(100).default([]),
  encryption: encryptionSchema.optional(),
  schedule: scheduleSchema.optional(),
  retention: retentionSchema.optional(),
  remoteRetention: retentionSchema.optional(),
  monitoring: monitoringSchema.optional(),
  notification: notificationSchema.optional(),
});
export const configSchema = z.strictObject({
  version: z.literal(1),
  storageDirectory: z.string().min(1).default('./backups'),
  postgresBinDirectory: z.string().min(1).optional(),
  ageBinDirectory: z.string().min(1).optional(),
  s3: s3Schema.optional(),
  sandboxResources: sandboxResourcesSchema.prefault({}),
  minimumFreeBytes: z.number().int().min(128 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER).default(128 * 1024 * 1024),
  maximumStorageBytes: z.number().int().min(128 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  projects: z.record(projectId, projectSchema).refine((value) => Object.keys(value).length > 0),
  restoreTargets: z.record(projectId, z.strictObject({
    environment: z.enum(['development', 'test']),
    connectionEnv: envName,
  })).default({}),
}).superRefine((value, ctx) => {
  for (const project of Object.values(value.projects)) {
    if (project.schedule?.upload && (!value.s3 || !project.encryption)) {
      ctx.addIssue({ code: 'custom', message: 'Scheduled upload requires S3 and project encryption.' });
    }
  }
});
export type Config = z.infer<typeof configSchema>;
export type Project = z.infer<typeof projectSchema>;
export interface LoadedConfig {
  readonly config: Config;
  readonly storageDirectory: string;
  readonly postgresBinDirectory: string | undefined;
  readonly ageBinDirectory?: string;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  let data: unknown;
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Too large');
    data = JSON.parse(text);
  } catch {
    throw new WitnessError('Cannot read configuration as JSON (maximum 1 MiB).');
  }
  const result = configSchema.safeParse(data);
  if (!result.success) throw new WitnessError('Invalid configuration. Check documented fields, identifiers, and value limits.');
  const base = dirname(resolve(path));
  return {
    config: result.data,
    storageDirectory: resolve(base, result.data.storageDirectory),
    postgresBinDirectory: result.data.postgresBinDirectory === undefined ? undefined : resolve(base, result.data.postgresBinDirectory),
    ...(result.data.ageBinDirectory ? { ageBinDirectory: resolve(base, result.data.ageBinDirectory) } : {}),
  };
}

export function selectProject(config: Config, id: string): Project {
  const project = config.projects[id];
  if (!project) throw new WitnessError('Unknown project. Use a configured project identifier.');
  return project;
}

export const exampleConfig = {
  version: 1,
  storageDirectory: './backups',
  timeoutSeconds: 300,
  projects: { example: { environment: 'development', connectionEnv: 'EXAMPLE_DATABASE_URL', assertions: [] } },
  restoreTargets: { recovery: { environment: 'test', connectionEnv: 'RECOVERY_DATABASE_URL' } },
} as const;
