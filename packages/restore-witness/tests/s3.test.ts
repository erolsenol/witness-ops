import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type LoadedConfig } from '../src/config.js';
import { listRemoteBackups, pruneRemote, pullBackup, pushBackup, recordRemoteVerification, withRemoteBackup } from '../src/s3.js';
import { atomicJson, type Manifest } from '../src/storage.js';

interface ObjectRecord { readonly body: Buffer; readonly metadata: Record<string, string>; }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(): Promise<{ loaded: LoadedConfig; manifest: Manifest; objects: Map<string, ObjectRecord>; signedRequests: string[]; faults: { failManifest: boolean; stallArtifact: boolean; pageSize: number; failArtifactDelete: boolean; ignoreDeleteCondition: boolean } }> {
  const root = await mkdtemp(join(tmpdir(), 'rw-s3-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const objects = new Map<string, ObjectRecord>();
  const signedRequests: string[] = [];
  const faults = { failManifest: false, stallArtifact: false, pageSize: 1000, failArtifactDelete: false, ignoreDeleteCondition: false };
  const server: Server = createServer((request, response) => {
    void (async () => {
      signedRequests.push(request.headers.authorization ?? '');
      const key = new URL(request.url ?? '/', 'http://localhost').pathname;
      const object = objects.get(key);
      const etag = (body: Buffer): string => `"${createHash('md5').update(body).digest('hex')}"`;
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = '/fixture-bucket/' + (url.searchParams.get('prefix') ?? '');
        const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
        const start = Number(url.searchParams.get('continuation-token') ?? 0);
        const selected = keys.slice(start, start + faults.pageSize);
        const more = start + selected.length < keys.length;
        response.writeHead(200, { 'Content-Type': 'application/xml' });
        response.end(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start+selected.length}</NextContinuationToken>` : ''}${selected.map((name) => `<Contents><Key>${name.slice('/fixture-bucket/'.length)}</Key></Contents>`).join('')}</ListBucketResult>`);
        return;
      }
      if (request.method === 'DELETE') {
        if (faults.failArtifactDelete && key.endsWith('.dump.age')) { response.writeHead(403); response.end(); return; }
        if (object && !faults.ignoreDeleteCondition && request.headers['if-match'] !== etag(object.body)) { response.writeHead(412); response.end(); return; }
        objects.delete(key); response.writeHead(204); response.end(); return;
      }
      if (request.method === 'PUT') {
        if (object && (request.headers['if-none-match'] === '*' || (request.headers['if-match'] && request.headers['if-match'] !== etag(object.body)))) { response.writeHead(412); response.end(); return; }
        const parts: Buffer[] = [];
        for await (const chunk of request) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        if (faults.failManifest && key.endsWith('manifest.json')) { response.writeHead(500, { 'Content-Type': 'application/xml' }); response.end('<Error><Code>InternalError</Code></Error>'); return; }
        const metadata: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) if (name.startsWith('x-amz-meta-') && typeof value === 'string') metadata[name.slice(11)] = value;
        objects.set(key, { body: Buffer.concat(parts), metadata });
        response.writeHead(200, { ETag: etag(Buffer.concat(parts)) }); response.end(); return;
      }
      if (!object) { response.writeHead(404, { 'Content-Type': 'application/xml' }); response.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      const headers: Record<string, string | number> = { 'Content-Length': object.body.length, ETag: etag(object.body) };
      for (const [name, value] of Object.entries(object.metadata)) headers[`x-amz-meta-${name}`] = value;
      response.writeHead(200, headers);
      if (faults.stallArtifact && key.endsWith('.dump.age') && request.method === 'GET') { response.write(object.body.subarray(0, 1)); return; }
      response.end(request.method === 'HEAD' ? undefined : object.body);
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  process.env.RW_S3_TEST_ACCESS = 'fixture-access'; process.env.RW_S3_TEST_SECRET = 'fixture-secret';
  cleanups.push(async () => { delete process.env.RW_S3_TEST_ACCESS; delete process.env.RW_S3_TEST_SECRET; });
  const loaded: LoadedConfig = { config: configSchema.parse({ version: 1, projects: { example: { environment: 'test', connectionEnv: 'DB' } }, s3: {
    bucket: 'fixture-bucket', region: 'us-east-1', endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true, allowInsecureLocalEndpoint: true,
    accessKeyEnv: 'RW_S3_TEST_ACCESS', secretKeyEnv: 'RW_S3_TEST_SECRET',
  } }), storageDirectory: root, postgresBinDirectory: undefined };
  const bytes = Buffer.from('age-encryption.org/v1\nfixture ciphertext');
  const manifest: Manifest = { version: 2, id: randomUUID(), project: 'example', environment: 'test', createdAt: new Date().toISOString(), serverMajor: 16, sourceFingerprint: 'a'.repeat(64), format: 'postgres-custom-age', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), assertions: [], encryption: { recipient: 'age1' + 'q'.repeat(58), plaintextSha256: 'b'.repeat(64), plaintextBytes: 5 } };
  await mkdir(join(root, manifest.id));
  await writeFile(join(root, manifest.id, 'backup.dump.age'), bytes);
  await atomicJson(join(root, manifest.id, 'manifest.json'), manifest);
  return { loaded, manifest, objects, signedRequests, faults };
}

describe('S3 adapter through real signed HTTP requests', () => {
  it('commits artifact before manifest and downloads without a local source copy', async () => {
    const { loaded, manifest, objects, signedRequests } = await fixture();
    expect(await pushBackup(loaded, manifest.id, { timeoutMs: 5000 })).toMatchObject({ uploaded: true, alreadyPresent: false });
    expect([...objects.keys()][0]).toContain('.dump.age');
    expect([...objects.keys()][1]).toContain('manifest.json');
    expect(signedRequests.every((header) => header.startsWith('AWS4-HMAC-SHA256'))).toBe(true);
    expect(await pushBackup(loaded, manifest.id, { timeoutMs: 5000 })).toMatchObject({ alreadyPresent: true });
    const original = await readFile(join(loaded.storageDirectory, manifest.id, 'backup.dump.age'));
    await rm(join(loaded.storageDirectory, manifest.id), { recursive: true });
    await withRemoteBackup(loaded, 'example', manifest.id, { timeoutMs: 5000 }, async (temporary) => {
      expect(await readFile(join(temporary.storageDirectory, manifest.id, 'backup.dump.age'))).toEqual(original);
    });
    expect((await readdir(loaded.storageDirectory)).filter((name) => name.startsWith('.remote-'))).toEqual([]);
    expect(await pullBackup(loaded, 'example', manifest.id, { timeoutMs: 5000 })).toMatchObject({ id: manifest.id, version: 2 });
    await expect(pullBackup(loaded, 'example', manifest.id, { timeoutMs: 5000 })).rejects.toThrow('will not overwrite');
  });
  it('rejects corrupted remote data and removes partial downloads', async () => {
    const { loaded, manifest, objects } = await fixture();
    await pushBackup(loaded, manifest.id, { timeoutMs: 5000 });
    const key = [...objects.keys()].find((key) => key.endsWith('.dump.age'));
    const record = key ? objects.get(key) : undefined;
    if (!key || !record) throw new Error('Missing fixture artifact.');
    objects.set(key, { ...record, body: Buffer.alloc(record.body.length) });
    await rm(join(loaded.storageDirectory, manifest.id), { recursive: true });
    await expect(pullBackup(loaded, 'example', manifest.id, { timeoutMs: 5000 })).rejects.toThrow('checksum');
    expect((await readdir(loaded.storageDirectory)).filter((name) => name.startsWith('.remote-'))).toEqual([]);
  });
  it('rejects mismatched remote identity before downloading any artifact', async () => {
    const { loaded, manifest, objects } = await fixture();
    const key = `/fixture-bucket/restore-witness/example/${manifest.id}/manifest.json`;
    objects.set(key, { body: Buffer.from(JSON.stringify({ ...manifest, project: 'other' })), metadata: {} });
    await rm(join(loaded.storageDirectory, manifest.id), { recursive: true });
    await expect(pullBackup(loaded, 'example', manifest.id, { timeoutMs: 5000 })).rejects.toThrow('identity');
  });
  it('refuses plaintext manifests before making S3 requests', async () => {
    const { loaded, manifest, signedRequests } = await fixture();
    const { encryption: _encryption, ...fields } = manifest as Extract<Manifest, { version: 2 }>;
    await atomicJson(join(loaded.storageDirectory, manifest.id, 'manifest.json'), { ...fields, version: 1, format: 'postgres-custom' });
    await expect(pushBackup(loaded, manifest.id, { timeoutMs: 5000 })).rejects.toThrow('Only age-encrypted');
    expect(signedRequests).toHaveLength(0);
  });
  it('does not commit a failed upload and can resume a completed orphan artifact', { timeout: 15_000 }, async () => {
    const { loaded, manifest, objects, faults } = await fixture();
    faults.failManifest = true;
    await expect(pushBackup(loaded, manifest.id, { timeoutMs: 5000 })).rejects.toThrow('S3 operation failed');
    expect([...objects.keys()].some((key) => key.endsWith('manifest.json'))).toBe(false);
    expect(objects.size).toBe(1);
    faults.failManifest = false;
    expect(await pushBackup(loaded, manifest.id, { timeoutMs: 5000 })).toMatchObject({ uploaded: true });
    expect(objects.size).toBe(2);
  });
  it('cancels stalled downloads and removes temporary data', async () => {
    const { loaded, manifest, faults } = await fixture();
    await pushBackup(loaded, manifest.id, { timeoutMs: 5000 });
    await rm(join(loaded.storageDirectory, manifest.id), { recursive: true });
    faults.stallArtifact = true;
    await expect(pullBackup(loaded, 'example', manifest.id, { timeoutMs: 5000, signal: AbortSignal.timeout(100) })).rejects.toThrow('cancelled');
    expect((await readdir(loaded.storageDirectory)).filter((name) => name.startsWith('.remote-'))).toEqual([]);
  });
});

describe('remote discovery and retention', () => {
  const options = { timeoutMs: 5000 };
  async function receipt(loaded: LoadedConfig, manifest: Manifest): Promise<void> {
    await recordRemoteVerification(loaded, manifest, { version: 1, backupId: manifest.id, project: manifest.project,
      verifiedAt: new Date().toISOString(), durationMs: 1, passed: true, checks: [{ name: 'restore', passed: true, detail: 'Synthetic receipt fixture' }] }, options);
  }
  it('discovers all committed backups across pages after the local catalog is lost', async () => {
    const { loaded, manifest, faults } = await fixture();
    await pushBackup(loaded, manifest.id, options); await receipt(loaded, manifest);
    faults.pageSize = 1;
    await rm(join(loaded.storageDirectory, manifest.id), { recursive: true });
    expect(await listRemoteBackups(loaded, 'example', options)).toMatchObject([{ manifest: { id: manifest.id }, verification: { passed: true } }]);
  });
  it('requires an explicit remote policy and blocks removal without remote verification', async () => {
    const { loaded, manifest, objects } = await fixture();
    await expect(pruneRemote(loaded, 'example', false, options)).rejects.toThrow('remoteRetention');
    await pushBackup(loaded, manifest.id, options);
    const second = { ...manifest, id: randomUUID(), createdAt: '2026-01-01T00:00:00Z' };
    for (const [key, value] of [...objects]) objects.set(key.replace(manifest.id, second.id), key.endsWith('manifest.json') ? { ...value, body: Buffer.from(JSON.stringify(second)) } : value);
    loaded.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
    expect(await pruneRemote(loaded, 'example', false, options)).toMatchObject({ blockedReason: expect.any(String), deleted: [] });
    await expect(pruneRemote(loaded, 'example', true, options)).rejects.toThrow('blocked');
    expect([...objects.keys()].filter((name) => name.endsWith('manifest.json'))).toHaveLength(2);
    expect([...objects.keys()].some((name) => name.endsWith('.retention-lock.json'))).toBe(false);
  });
  it('protects newest and verified remote backups, previews without writes, and removes exact candidates', async () => {
    const { loaded, manifest, objects } = await fixture();
    await pushBackup(loaded, manifest.id, options); await receipt(loaded, manifest);
    const old = { ...manifest, id: randomUUID(), createdAt: '2026-01-01T00:00:00Z' };
    for (const [key, value] of [...objects]) {
      if (key.endsWith('verification.json')) continue;
      objects.set(key.replace(manifest.id, old.id), key.endsWith('manifest.json') ? { ...value, body: Buffer.from(JSON.stringify(old)) } : value);
    }
    loaded.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
    const count = objects.size;
    expect(await pruneRemote(loaded, 'example', false, options)).toMatchObject({ protectedVerifiedId: manifest.id, remove: [{ backupId: old.id }], deleted: [] });
    expect(objects.size).toBe(count);
    expect(await pruneRemote(loaded, 'example', true, options)).toMatchObject({ deleted: [old.id], protectedVerifiedId: manifest.id });
    expect(await listRemoteBackups(loaded, 'example', options)).toHaveLength(1);
    expect([...objects.keys()].some((name) => name.includes(old.id))).toBe(false);
  });
  it('fails closed on corrupted remote artifacts and invalid verification receipts', async () => {
    const { loaded, manifest, objects } = await fixture();
    await pushBackup(loaded, manifest.id, options); await receipt(loaded, manifest);
    loaded.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
    const key = `/fixture-bucket/restore-witness/example/${manifest.id}/verification.json`;
    const original = objects.get(key)!;
    objects.set(key, { ...original, body: Buffer.from('{}') });
    await expect(pruneRemote(loaded, 'example', true, options)).rejects.toThrow('receipt');
    objects.set(key, original);
    const artifact = [...objects.keys()].find((name) => name.endsWith('.dump.age'))!;
    objects.set(artifact, { body: Buffer.from('corrupt'), metadata: {} });
    await expect(pruneRemote(loaded, 'example', true, options)).rejects.toThrow();
    expect(objects.has(`/fixture-bucket/restore-witness/example/${manifest.id}/manifest.json`)).toBe(true);
  });
  it('rejects changed manifests when committing verification and mismatched environments during discovery', async () => {
    const { loaded, manifest, objects } = await fixture();
    await pushBackup(loaded, manifest.id, options);
    const key = `/fixture-bucket/restore-witness/example/${manifest.id}/manifest.json`;
    const original = objects.get(key)!;
    objects.set(key, { ...original, body: Buffer.from(JSON.stringify({ ...manifest, environment: 'production' })) });
    await expect(listRemoteBackups(loaded, 'example', options)).rejects.toThrow('environment');
    await expect(receipt(loaded, manifest)).rejects.toThrow('changed');
  });
  it('rejects a held remote retention lock and enforces pull quota before download', async () => {
    const { loaded, manifest, objects } = await fixture();
    await pushBackup(loaded, manifest.id, options);
    loaded.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
    objects.set('/fixture-bucket/restore-witness/example/.retention-lock.json', { body: Buffer.from('{}'), metadata: {} });
    await expect(pruneRemote(loaded, 'example', true, options)).rejects.toThrow();
    await rm(join(loaded.storageDirectory, manifest.id), { recursive: true });
    loaded.config.maximumStorageBytes = manifest.bytes - 1;
    await expect(pullBackup(loaded, 'example', manifest.id, options)).rejects.toThrow('quota');
    expect((await readdir(loaded.storageDirectory)).some((name) => name.startsWith('.remote-'))).toBe(false);
  });
});

describe('remote retention partial failure guards', () => {
  it('refuses providers that ignore conditional deletion before deleting any backup', async () => {
    const { loaded, manifest, objects, faults } = await fixture();
    await pushBackup(loaded, manifest.id, { timeoutMs: 5000 });
    loaded.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
    faults.ignoreDeleteCondition = true;
    await expect(pruneRemote(loaded, 'example', true, { timeoutMs: 5000 })).rejects.toThrow('does not enforce');
    expect([...objects.keys()].filter((name) => name.endsWith('manifest.json'))).toHaveLength(1);
  });
  it('leaves only uncommitted ciphertext after marker-first partial deletion failure', async () => {
    const { loaded, manifest, objects, faults } = await fixture(); const options = { timeoutMs: 5000 };
    await pushBackup(loaded, manifest.id, options);
    await recordRemoteVerification(loaded, manifest, { version: 1, backupId: manifest.id, project: 'example', verifiedAt: new Date().toISOString(), durationMs: 1,
      passed: true, checks: [{ name: 'restore', passed: true, detail: 'Synthetic proof' }] }, options);
    const old = { ...manifest, id: randomUUID(), createdAt: '2026-01-01T00:00:00Z' };
    for (const [key, value] of [...objects]) {
      if (key.endsWith('verification.json')) continue;
      objects.set(key.replace(manifest.id, old.id), key.endsWith('manifest.json') ? { ...value, body: Buffer.from(JSON.stringify(old)) } : value);
    }
    loaded.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
    faults.failArtifactDelete = true;
    await expect(pruneRemote(loaded, 'example', true, options)).rejects.toThrow();
    expect(objects.has(`/fixture-bucket/restore-witness/example/${old.id}/manifest.json`)).toBe(false);
    expect([...objects.keys()].some((key) => key.includes(old.id) && key.endsWith('.dump.age'))).toBe(true);
    expect(await listRemoteBackups(loaded, 'example', options)).toHaveLength(1);
    expect([...objects.keys()].some((key) => key.endsWith('.retention-lock.json'))).toBe(false);
  });
});
