import { AbortMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { selectProject, type LoadedConfig } from './config.js';
import { WitnessError } from './errors.js';
import type { ProcessOptions } from './process.js';
import { artifactName, atomicJson, backupDirectory, backupIdSchema, loadManifest, manifestSchema, validateArtifact, verificationSchema, withProjectLock, type Manifest, type VerificationReport } from './storage.js';
import { withStorageBudget } from './quota.js';
import { evaluateRetention, type RetentionItem } from './retention.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new WitnessError('Required S3 credential environment variable is missing.');
  return value;
}

async function withS3<T>(loaded: LoadedConfig, options: ProcessOptions, operation: (client: S3Client, bucket: string, prefix: string) => Promise<T>): Promise<T> {
  const config = loaded.config.s3;
  if (!config) throw new WitnessError('S3 storage is not configured.');
  const client = new S3Client({
    region: config.region, forcePathStyle: config.forcePathStyle,
    ignoreConfiguredEndpointUrls: true,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: {
      accessKeyId: requiredEnv(config.accessKeyEnv), secretAccessKey: requiredEnv(config.secretKeyEnv),
      ...(config.sessionTokenEnv ? { sessionToken: requiredEnv(config.sessionTokenEnv) } : {}),
    },
    maxAttempts: 2, retryMode: 'standard',
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 10_000, requestTimeout: options.timeoutMs },
  });
  try {
    return await operation(client, config.bucket, config.prefix.replace(/\/+$/, ''));
  } catch (error) {
    if (error instanceof WitnessError) throw error;
    throw new WitnessError(options.signal?.aborted ? 'S3 operation cancelled.' : 'S3 operation failed. Check endpoint, credentials, permissions, and connectivity.');
  } finally { client.destroy(); }
}

function objectPrefix(prefix: string, project: string, id: string): string {
  if (!backupIdSchema.safeParse(id).success) throw new WitnessError('Invalid backup identifier.');
  return `${prefix}/${project}/${id}`;
}

async function readRemoteManifest(client: S3Client, bucket: string, key: string, project: string, id: string, options: ProcessOptions): Promise<Manifest | null> {
  let response;
  try {
    response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
    throw error;
  }
  if (!(response.Body instanceof Readable)) throw new WitnessError('S3 did not return a readable metadata stream.');
  const body = response.Body;
  const cancel = (): void => { body.destroy(new WitnessError('S3 operation cancelled.')); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (options.signal?.aborted) throw new WitnessError('S3 operation cancelled.');
    if ((response.ContentLength ?? 0) > 1024 * 1024) throw new WitnessError('Remote manifest exceeds 1 MiB.');
    for await (const chunk of body) {
      if (options.signal?.aborted) throw new WitnessError('S3 operation cancelled.');
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > 1024 * 1024) throw new WitnessError('Remote manifest exceeds 1 MiB.');
      chunks.push(buffer);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new WitnessError('Remote manifest is not valid JSON.'); }
    const parsed = manifestSchema.safeParse(data);
    if (!parsed.success || parsed.data.id !== id || parsed.data.project !== project || parsed.data.version !== 2) throw new WitnessError('Remote manifest identity or encryption format is invalid.');
    return parsed.data;
  } finally { options.signal?.removeEventListener('abort', cancel); body.destroy(); }
}

class BoundedDigest extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;
  constructor(private readonly expectedBytes: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.expectedBytes) { callback(new WitnessError('S3 artifact exceeded its manifest size.')); return; }
    this.hash.update(chunk);
    callback(null, chunk);
  }
  matches(sha256: string): boolean { return this.bytes === this.expectedBytes && this.hash.digest('hex') === sha256; }
}

async function artifactExists(client: S3Client, bucket: string, key: string, manifest: Manifest, options: ProcessOptions): Promise<boolean> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
    if (head.ContentLength !== manifest.bytes || head.Metadata?.sha256 !== manifest.sha256) throw new WitnessError('Existing remote artifact does not match the manifest.');
    return true;
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return false;
    throw error;
  }
}

async function validateRemoteBytes(client: S3Client, bucket: string, key: string, manifest: Manifest, options: ProcessOptions): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
  if (!(response.Body instanceof Readable)) throw new WitnessError('S3 did not return a readable artifact stream.');
  const digest = new BoundedDigest(manifest.bytes);
  try {
    await pipeline(response.Body, digest, new Writable({ write(_chunk: Buffer, _encoding: BufferEncoding, callback) { callback(); } }), { ...(options.signal ? { signal: options.signal } : {}) });
    if (!digest.matches(manifest.sha256)) throw new WitnessError('Existing remote artifact checksum does not match.');
  } finally { response.Body.destroy(); }
}

export interface PushResult {
  readonly backupId: string;
  readonly uploaded: true;
  readonly alreadyPresent: boolean;
}

export async function pushBackup(loaded: LoadedConfig, id: string, options: ProcessOptions): Promise<PushResult> {
  const manifest = await loadManifest(loaded.storageDirectory, id);
  selectProject(loaded.config, manifest.project);
  if (manifest.version !== 2) throw new WitnessError('Only age-encrypted backups may be uploaded to S3.');
  return withProjectLock(loaded.storageDirectory, manifest.project, async () => {
    const path = await validateArtifact(loaded.storageDirectory, manifest, options.signal);
    return withS3(loaded, options, async (client, bucket, prefix) => {
      const base = objectPrefix(prefix, manifest.project, id);
      const existing = await readRemoteManifest(client, bucket, `${base}/manifest.json`, manifest.project, id, options);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(manifestSchema.parse(manifest))) throw new WitnessError('Remote backup identity already exists with different metadata.');
        await validateRemoteBytes(client, bucket, `${base}/${manifest.sha256}.dump.age`, manifest, options);
        return { backupId: id, uploaded: true, alreadyPresent: true };
      }
      const key = `${base}/${manifest.sha256}.dump.age`;
      if (await artifactExists(client, bucket, key, manifest, options)) {
        await validateRemoteBytes(client, bucket, key, manifest, options);
      } else {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const source = file.createReadStream();
        const digest = new BoundedDigest(manifest.bytes);
        const upload = new Upload({ client,
          params: { Bucket: bucket, Key: key, Body: digest, ContentLength: manifest.bytes, IfNoneMatch: '*',
            ContentType: 'application/octet-stream', Metadata: { sha256: manifest.sha256 } },
          partSize: 8 * 1024 * 1024, queueSize: 1, leavePartsOnError: false,
        });
        const cancel = (): void => { source.destroy(); digest.destroy(); void upload.abort().catch(() => undefined); };
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        try {
          await Promise.all([pipeline(source, digest), upload.done()]);
          if (!digest.matches(manifest.sha256)) throw new WitnessError('Backup changed during upload. Remote manifest was not published.');
        } catch (error) {
          await upload.abort().catch(() => undefined);
          source.destroy(); digest.destroy();
          if (upload.uploadId) {
            try {
              await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: upload.uploadId }), { abortSignal: AbortSignal.timeout(10_000) });
            } catch (cleanupError) {
              if (!(cleanupError instanceof S3ServiceException && cleanupError.$metadata.httpStatusCode === 404)) throw new WitnessError('Multipart cleanup failed. Inspect incomplete uploads for this backup before retrying.');
            }
          }
          throw error;
        } finally {
          options.signal?.removeEventListener('abort', cancel);
          source.destroy(); digest.destroy(); if (file.fd >= 0) await file.close();
        }
      }
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${base}/${manifest.sha256}.dump.age` }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
      if (head.ContentLength !== manifest.bytes || head.Metadata?.sha256 !== manifest.sha256) throw new WitnessError('S3 did not acknowledge the expected artifact.');
      // Manifest is the commit marker, published only after the full artifact.
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${base}/manifest.json`,
        Body: `${JSON.stringify(manifest, null, 2)}\n`, ContentType: 'application/json', IfNoneMatch: '*',
      }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
      return { backupId: id, uploaded: true, alreadyPresent: false };
    });
  });
}

async function fetchToTemporary(loaded: LoadedConfig, project: string, id: string, options: ProcessOptions, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<{ root: string; manifest: Manifest }> {
  selectProject(loaded.config, project);
  backupDirectory(loaded.storageDirectory, id);
  await mkdir(loaded.storageDirectory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(loaded.storageDirectory, '.remote-'));
  try {
    const manifest = await withS3(loaded, options, async (client, bucket, prefix) => {
      const base = objectPrefix(prefix, project, id);
      const manifest = await readRemoteManifest(client, bucket, `${base}/manifest.json`, project, id, options);
      if (!manifest) throw new WitnessError('Remote committed backup was not found.');
      if (manifest.environment !== selectProject(loaded.config, project).environment) throw new WitnessError('Remote backup environment differs from configured project.');
      if (manifest.bytes > maximumBytes) throw new WitnessError('Remote artifact exceeds the remaining local storage quota.');
      const space = await statfs(root);
      if (space.bavail * space.bsize < manifest.bytes + 128 * 1024 * 1024) throw new WitnessError('Insufficient free disk space for remote artifact download.');
      const directory = backupDirectory(root, id);
      await mkdir(directory, { mode: 0o700 });
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${base}/${manifest.sha256}.dump.age` }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
      if (!(response.Body instanceof Readable)) throw new WitnessError('S3 did not return a readable artifact stream.');
      if (response.ContentLength !== undefined && response.ContentLength !== manifest.bytes) { response.Body.destroy(); throw new WitnessError('Remote artifact size does not match the manifest.'); }
      const path = join(directory, artifactName(manifest));
      const file = await open(path, 'wx', 0o600);
      const digest = new BoundedDigest(manifest.bytes);
      try {
        await pipeline(response.Body, digest, file.createWriteStream(), { ...(options.signal ? { signal: options.signal } : {}) });
        if (!digest.matches(manifest.sha256)) throw new WitnessError('Remote artifact checksum or size does not match the manifest.');
        const synced = await open(path, 'r');
        try { await synced.sync(); } finally { await synced.close(); }
      } finally { response.Body.destroy(); if (file.fd >= 0) await file.close(); }
      await atomicJson(join(directory, 'manifest.json'), manifest);
      return manifest;
    });
    return { root, manifest };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function pullBackup(loaded: LoadedConfig, project: string, id: string, options: ProcessOptions): Promise<Manifest> {
  selectProject(loaded.config, project);
  return withProjectLock(loaded.storageDirectory, project, () => withStorageBudget(loaded, async (remainingBytes) => {
    const destination = backupDirectory(loaded.storageDirectory, id);
    const exists = await lstat(destination).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (exists) throw new WitnessError('Local backup identifier already exists; pull will not overwrite it.');
    const fetched = await fetchToTemporary(loaded, project, id, options, remainingBytes);
    try { await rename(backupDirectory(fetched.root, id), destination); return fetched.manifest; }
    finally { await rm(fetched.root, { recursive: true, force: true }); }
  }));
}

export async function withRemoteBackup<T>(loaded: LoadedConfig, project: string, id: string, options: ProcessOptions, operation: (temporary: LoadedConfig) => Promise<T>): Promise<T> {
  selectProject(loaded.config, project);
  return withProjectLock(loaded.storageDirectory, project, async () => {
    const fetched = await fetchToTemporary(loaded, project, id, options);
    try { return await operation({ ...loaded, storageDirectory: fetched.root }); }
    finally { await rm(fetched.root, { recursive: true, force: true }); }
  });
}

const receiptSchema = z.strictObject({ version: z.literal(1), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/), report: verificationSchema });

async function readRemoteJson(client: S3Client, bucket: string, key: string, options: ProcessOptions): Promise<{ data: unknown; etag: string } | null> {
  let response;
  try { response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { ...(options.signal ? { abortSignal: options.signal } : {}) }); }
  catch (error) { if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null; throw error; }
  if (!(response.Body instanceof Readable)) throw new WitnessError('Remote metadata stream is unavailable.');
  const body = response.Body;
  const cancel = (): void => { body.destroy(new WitnessError('S3 operation cancelled.')); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) throw new WitnessError('S3 operation cancelled.');
    if (!response.ETag || (response.ContentLength ?? 0) > 1024 * 1024) throw new WitnessError('Remote metadata identity or size is unsupported.');
    let bytes = 0; const parts: Buffer[] = [];
    for await (const chunk of body) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += part.length;
      if (bytes > 1024 * 1024) throw new WitnessError('Remote metadata exceeds 1 MiB.');
      parts.push(part);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new WitnessError('Invalid remote metadata JSON.'); }
    return { data, etag: response.ETag };
  } finally { options.signal?.removeEventListener('abort', cancel); body.destroy(); }
}

interface RemoteEntry { readonly manifest: Manifest; readonly etag: string; readonly receipt: { readonly report: VerificationReport; readonly etag: string } | null }
async function remoteCatalog(client: S3Client, bucket: string, prefix: string, loaded: LoadedConfig, projectId: string, options: ProcessOptions): Promise<readonly RemoteEntry[]> {
  const project = selectProject(loaded.config, projectId);
  const base = `${prefix}/${projectId}/`; const ids = new Set<string>(); const tokens = new Set<string>();
  let token: string | undefined;
  do {
    if (options.signal?.aborted) throw new WitnessError('S3 operation cancelled.');
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: base, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
    for (const object of page.Contents ?? []) {
      const relative = object.Key?.startsWith(base) ? object.Key.slice(base.length) : '';
      const [id, name, extra] = relative.split('/');
      if (id && name === 'manifest.json' && extra === undefined && backupIdSchema.safeParse(id).success) ids.add(id);
    }
    if (ids.size > 10000 || tokens.size >= 100) throw new WitnessError('Remote catalog exceeds discovery limits; no partial retention plan is allowed.');
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || tokens.has(token))) throw new WitnessError('Invalid S3 pagination; catalog is incomplete.');
    if (token) tokens.add(token);
  } while (token);
  const entries: RemoteEntry[] = [];
  for (const id of ids) {
    const raw = await readRemoteJson(client, bucket, `${base}${id}/manifest.json`, options);
    if (!raw) throw new WitnessError('Remote catalog changed during discovery. Retry the preview.');
    const parsed = manifestSchema.safeParse(raw.data);
    if (!parsed.success || parsed.data.id !== id || parsed.data.project !== projectId || parsed.data.environment !== project.environment || parsed.data.version !== 2) throw new WitnessError('Remote catalog contains invalid project/environment/encryption metadata.');
    const receipt = await readRemoteJson(client, bucket, `${base}${id}/verification.json`, options);
    let proof: RemoteEntry['receipt'] = null;
    if (receipt) {
      const value = receiptSchema.safeParse(receipt.data);
      if (!value.success || value.data.artifactSha256 !== parsed.data.sha256 || value.data.report.backupId !== id || value.data.report.project !== projectId
        || value.data.report.passed !== value.data.report.checks.every((check) => check.passed)) throw new WitnessError('Remote verification receipt does not match its committed artifact.');
      const report = value.data.report;
      proof = { etag: receipt.etag, report: { ...report, ...(report.imageId ? { imageId: report.imageId } : {}) } as VerificationReport };
    }
    entries.push({ manifest: parsed.data, etag: raw.etag, receipt: proof });
  }
  return entries.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || a.manifest.id.localeCompare(b.manifest.id));
}

export async function listRemoteBackups(loaded: LoadedConfig, project: string, options: ProcessOptions): Promise<readonly { readonly manifest: Manifest; readonly verification: VerificationReport | null }[]> {
  selectProject(loaded.config, project);
  return withS3(loaded, options, async (client, bucket, prefix) => (await remoteCatalog(client, bucket, prefix, loaded, project, options))
    .map((entry) => ({ manifest: entry.manifest, verification: entry.receipt?.report ?? null })));
}

export async function recordRemoteVerification(loaded: LoadedConfig, expectedManifest: Manifest, report: VerificationReport, options: ProcessOptions): Promise<void> {
  const { project, id } = expectedManifest;
  if (!report.passed) return;
  const validated = verificationSchema.safeParse(report);
  if (!validated.success || report.backupId !== id || report.project !== project || !report.checks.every((check) => check.passed)) throw new WitnessError('Cannot commit invalid remote verification evidence.');
  await withS3(loaded, options, async (client, bucket, prefix) => {
    const base = objectPrefix(prefix, project, id);
    const manifest = await readRemoteManifest(client, bucket, `${base}/manifest.json`, project, id, options);
    if (!manifest || manifest.environment !== selectProject(loaded.config, project).environment || JSON.stringify(manifest) !== JSON.stringify(manifestSchema.parse(expectedManifest))) throw new WitnessError('Remote backup disappeared or changed before verification receipt.');
    const key = `${base}/verification.json`;
    const previous = await readRemoteJson(client, bucket, key, options);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify({ version: 1, artifactSha256: manifest.sha256, report }),
      ContentType: 'application/json', ...(previous ? { IfMatch: previous.etag } : { IfNoneMatch: '*' }) }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
  });
}

export interface RemoteRetentionPlan {
  readonly project: string; readonly scope: 's3'; readonly apply: boolean;
  readonly keep: readonly RetentionItem[]; readonly remove: readonly RetentionItem[];
  readonly protectedVerifiedId: string | null; readonly blockedReason: string | null;
  readonly reclaimableBytes: number; readonly deleted: readonly string[];
}

export async function pruneRemote(loaded: LoadedConfig, projectId: string, apply: boolean, options: ProcessOptions): Promise<RemoteRetentionPlan> {
  const project = selectProject(loaded.config, projectId);
  if (!project.remoteRetention) throw new WitnessError('This project has no explicit remoteRetention policy.');
  return withProjectLock(loaded.storageDirectory, projectId, () => withS3(loaded, options, async (client, bucket, prefix) => {
    const key = `${prefix}/${projectId}/.retention-lock.json`;
    let lease: string | undefined;
    if (apply) {
      const acquired = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: '*',
        Body: JSON.stringify({ id: randomUUID(), startedAt: new Date().toISOString() }), ContentType: 'application/json' }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
      lease = acquired.ETag;
      if (!lease) throw new WitnessError('Remote retention lock identity unavailable. Inspect the exact lock object.');
    }
    try {
      if (apply) {
        let enforced = false;
        try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: `"invalid-${randomUUID()}"` }), { ...(options.signal ? { abortSignal: options.signal } : {}) }); }
        catch (error) { if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) enforced = true; else throw error; }
        if (!enforced) throw new WitnessError('S3 provider does not enforce conditional deletion. No backup deletion was attempted.');
      }
      const entries = await remoteCatalog(client, bucket, prefix, loaded, projectId, options);
      let protectedVerifiedId: string | null = null;
      for (const entry of entries) {
        if (entry.receipt?.report.passed && !protectedVerifiedId) {
          await validateRemoteBytes(client, bucket, `${objectPrefix(prefix, projectId, entry.manifest.id)}/${entry.manifest.sha256}.dump.age`, entry.manifest, options);
          protectedVerifiedId = entry.manifest.id;
        }
      }
      const plan = evaluateRetention(entries.map((entry) => entry.manifest), project.remoteRetention ?? { timeZone: 'UTC', daily: 7, weekly: 4, monthly: 12 }, protectedVerifiedId);
      const blockedReason = plan.remove.length > 0 && protectedVerifiedId === null ? 'No intact remotely verified recovery point is available.' : null;
      const deleted: string[] = [];
      if (apply) {
        if (blockedReason) throw new WitnessError(`Remote retention blocked: ${blockedReason}`);
        const objects = new Map<string, { artifactEtag: string; entry: RemoteEntry }>();
        // Validate all artifacts before removing any commit marker.
        for (const entry of entries) {
          const artifactKey = `${objectPrefix(prefix, projectId, entry.manifest.id)}/${entry.manifest.sha256}.dump.age`;
          await validateRemoteBytes(client, bucket, artifactKey, entry.manifest, options);
          const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: artifactKey }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
          if (!head.ETag || head.ContentLength !== entry.manifest.bytes || head.Metadata?.sha256 !== entry.manifest.sha256) throw new WitnessError('Remote artifact identity changed during retention.');
          objects.set(entry.manifest.id, { entry, artifactEtag: head.ETag });
        }
        for (const item of plan.remove) {
          const object = objects.get(item.backupId);
          if (!object) throw new WitnessError('Retention candidate disappeared.');
          const base = objectPrefix(prefix, projectId, item.backupId);
          const sendDelete = async (objectKey: string, etag: string): Promise<void> => {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey, IfMatch: etag }), { ...(options.signal ? { abortSignal: options.signal } : {}) });
          };
          // Marker first: any interruption leaves only uncommitted objects, never a falsely recoverable entry.
          await sendDelete(`${base}/manifest.json`, object.entry.etag);
          if (object.entry.receipt) await sendDelete(`${base}/verification.json`, object.entry.receipt.etag);
          await sendDelete(`${base}/${object.entry.manifest.sha256}.dump.age`, object.artifactEtag);
          deleted.push(item.backupId);
        }
      }
      return { project: projectId, scope: 's3', apply, ...plan, protectedVerifiedId, blockedReason, reclaimableBytes: plan.remove.reduce((sum, item) => sum + item.bytes, 0), deleted };
    } finally {
      if (lease) {
        try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: lease }), { abortSignal: AbortSignal.timeout(10_000) }); }
        catch { throw new WitnessError('Remote retention lock cleanup failed. Inspect the exact .retention-lock.json and catalog; deletions may already be complete.'); }
      }
    }
  }));
}
