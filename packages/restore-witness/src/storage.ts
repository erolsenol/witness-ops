import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ageRecipient, projectId, projectSchema, sandboxResourcesSchema, type SandboxResources } from './config.js';
import { WitnessError } from './errors.js';

export const backupIdSchema = z.string().uuid();
const manifestFields = {
  id: backupIdSchema,
  project: projectId,
  environment: projectSchema.shape.environment,
  createdAt: z.string().datetime(),
  snapshotStartedAt: z.string().datetime().optional(),
  serverMajor: z.number().int().min(16).max(18),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assertions: projectSchema.shape.assertions,
};
export const manifestSchema = z.discriminatedUnion('version', [
  z.strictObject({ ...manifestFields, version: z.literal(1), format: z.literal('postgres-custom') }),
  z.strictObject({ ...manifestFields, version: z.literal(2), format: z.literal('postgres-custom-age'),
    encryption: z.strictObject({ recipient: ageRecipient, plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/), plaintextBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  }),
]).superRefine((manifest, ctx) => {
  if (manifest.snapshotStartedAt && manifest.snapshotStartedAt > manifest.createdAt) ctx.addIssue({ code: 'custom', message: 'Snapshot start cannot follow backup completion.' });
});
export type Manifest = z.infer<typeof manifestSchema>;
export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}
export interface VerificationReport {
  readonly version: 1;
  readonly backupId: string;
  readonly project: string;
  readonly verifiedAt: string;
  readonly durationMs: number;
  readonly passed: boolean;
  readonly imageId?: string;
  readonly sandboxResources?: SandboxResources;
  readonly checks: readonly VerificationCheck[];
}
export const verificationSchema = z.strictObject({
  version: z.literal(1), backupId: backupIdSchema, project: projectId,
  verifiedAt: z.string().datetime(), durationMs: z.number().int().nonnegative(),
  passed: z.boolean(), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  sandboxResources: z.strictObject({
    memoryMiB: sandboxResourcesSchema.shape.memoryMiB.unwrap(),
    cpus: sandboxResourcesSchema.shape.cpus.unwrap(),
    pidsLimit: sandboxResourcesSchema.shape.pidsLimit.unwrap(),
  }).optional(),
  checks: z.array(z.strictObject({ name: z.string().max(200), passed: z.boolean(), detail: z.string().max(500) })).min(1).max(110),
});

export async function loadVerification(root: string, manifest: Manifest): Promise<VerificationReport | null> {
  const path = join(backupDirectory(root, manifest.id), 'verification.json');
  const exists = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) return null;
  const result = verificationSchema.safeParse(await readJson(path));
  if (!result.success || result.data.backupId !== manifest.id || result.data.project !== manifest.project || result.data.passed !== result.data.checks.every((check) => check.passed)) throw new WitnessError('Invalid verification report.');
  const { imageId, sandboxResources, ...report } = result.data;
  return { ...report, ...(imageId ? { imageId } : {}), ...(sandboxResources ? { sandboxResources } : {}) };
}

export async function readJson(path: string): Promise<unknown> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid file');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new WitnessError('Cannot read valid metadata JSON (maximum 1 MiB; symbolic links are not allowed).');
  }
}

export async function atomicJson(path: string, data: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function backupDirectory(root: string, id: string): string {
  if (!backupIdSchema.safeParse(id).success) throw new WitnessError('Invalid backup identifier.');
  return join(root, id);
}

export async function loadManifest(root: string, id: string): Promise<Manifest> {
  const directory = backupDirectory(root, id);
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new WitnessError('Backup directory is missing or unsafe.');
  const result = manifestSchema.safeParse(await readJson(join(directory, 'manifest.json')));
  if (!result.success || result.data.id !== id) throw new WitnessError('Invalid backup manifest.');
  return result.data;
}

export async function artifactDigest(path: string, signal?: AbortSignal): Promise<{ readonly sha256: string; readonly bytes: number }> {
  if (signal?.aborted) throw new WitnessError('Operation cancelled.');
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) throw new WitnessError('Backup artifact is missing or unsafe.');
  const hash = createHash('sha256');
  let bytes = 0;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of file.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      hash.update(buffer);
      bytes += buffer.length;
    }
  } finally { await file.close(); }
  return { sha256: hash.digest('hex'), bytes };
}

export async function validateArtifact(root: string, manifest: Manifest, signal?: AbortSignal): Promise<string> {
  const path = join(backupDirectory(root, manifest.id), artifactName(manifest));
  const actual = await artifactDigest(path, signal);
  if (actual.sha256 !== manifest.sha256 || actual.bytes !== manifest.bytes) throw new WitnessError('Backup checksum or size does not match its manifest.');
  return path;
}

export function artifactName(manifest: Manifest): 'backup.dump' | 'backup.dump.age' {
  return manifest.version === 2 ? 'backup.dump.age' : 'backup.dump';
}

export async function listBackups(root: string, project: string): Promise<readonly Manifest[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const result: Manifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !backupIdSchema.safeParse(entry.name).success) continue;
    const manifest = await loadManifest(root, entry.name);
    if (manifest.project === project) result.push(manifest);
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function withProjectLock<T>(root: string, project: string, operation: () => Promise<T>): Promise<T> {
  if (!projectId.safeParse(project).success) throw new WitnessError('Invalid project identifier.');
  return withNamedLock(root, project, operation);
}

export async function withStorageQuotaLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  // @ cannot appear in a project identifier, so this lock has a separate namespace.
  return withNamedLock(root, '@storage-quota', operation);
}

async function withNamedLock<T>(root: string, project: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(join(root, '.locks'), { recursive: true, mode: 0o700 });
  const path = join(root, '.locks', `${project}.lock`);
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw new WitnessError('Project is locked or storage is inaccessible. Check for another running job; inspect stale locks before removing them.'); }
  try {
    await atomicJson(join(path, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
    return await operation();
  } finally { await rm(path, { recursive: true, force: true }); }
}
