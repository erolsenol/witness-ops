import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, type LoadedConfig } from '../src/config.js';
import { backup, doctor, restore, status, verify } from '../src/operations.js';
import { connectionFromEnv, query } from '../src/postgres.js';
import { runProcess } from '../src/process.js';
import { artifactDigest, atomicJson, listBackups, type Manifest } from '../src/storage.js';
import { ageTool, encryptArtifact } from '../src/encryption.js';
import { monitor } from '../src/monitoring.js';
import { tick } from '../src/scheduler.js';
import { prune } from '../src/retention.js';
import { drill } from '../src/drill.js';
import { withSandbox } from '../src/sandbox.js';
import { listRemoteBackups, pruneRemote, pullBackup, pushBackup, recordRemoteVerification, withRemoteBackup } from '../src/s3.js';

// Explicit opt-in: never connect to an ambient application DATABASE_URL.
const enabled = process.env.RW_INTEGRATION === '1';
describe.runIf(enabled)('real PostgreSQL recovery workflow', { timeout: 180_000 }, () => {
  const options = { timeoutMs: 60_000 };
  const name = `restore-witness-test-${randomUUID()}`;
  const major = Number(process.env.RW_TEST_MAJOR ?? '16');
  const directory = process.env.RW_POSTGRES_BIN_DIRECTORY;
  const native = process.env.RW_TEST_NATIVE === '1';
  let nativeStarted = false;
  let root = '';
  let loaded: LoadedConfig;
  let manifest: Manifest;
  let sourceUrl = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rw-integration-'));
    const password = randomUUID();
    let port: string;
    if (native) {
      if (!directory) throw new Error('Native tests require RW_POSTGRES_BIN_DIRECTORY.');
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Cannot allocate test port.');
      port = String(address.port);
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await runProcess(join(directory, 'initdb'), ['-D', join(root, 'pgdata'), '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--no-locale'], options);
      await runProcess(join(directory, 'pg_ctl'), ['-D', join(root, 'pgdata'), '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${root}`, '-w', 'start'], options);
      nativeStarted = true;
    } else {
      await runProcess('docker', ['create', '--name', name, '--label', 'org.restore-witness.test=true',
        '--memory', '512m', '--cpus', '1', '-p', '127.0.0.1::5432',
        '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=source', `postgres:${major}`], options);
      await runProcess('docker', ['start', name], options);
      port = await runProcess('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name], options);
    }
    sourceUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/source`;
    process.env.RW_INTEGRATION_SOURCE = sourceUrl;
    process.env.RW_INTEGRATION_TARGET = sourceUrl.replace('/source', '/recovery');
    if (native) {
      process.env.RW_INTEGRATION_ADMIN = sourceUrl.replace('/source', '/postgres');
      await query(directory, connectionFromEnv('RW_INTEGRATION_ADMIN'), 'CREATE DATABASE source', options);
    }
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await query(directory, connectionFromEnv('RW_INTEGRATION_SOURCE'), 'SELECT 1', { timeoutMs: 1000 });
        ready = true;
        break;
      } catch { await delay(100); }
    }
    if (!ready) throw new Error('Test PostgreSQL did not become ready.');
    await query(directory, connectionFromEnv('RW_INTEGRATION_SOURCE'), `
      CREATE TABLE accounts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);
      INSERT INTO accounts (name) VALUES ('alpha'), ('beta');
      CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id bigint REFERENCES accounts(id));
      INSERT INTO orders (account_id) VALUES (1);
      CREATE VIEW account_names AS SELECT name FROM accounts;
      CREATE DATABASE recovery;
    `.replace('CREATE DATABASE recovery;', ''), options);
    await query(directory, connectionFromEnv('RW_INTEGRATION_SOURCE'), 'CREATE DATABASE recovery', options);
    loaded = {
      config: configSchema.parse({ version: 1, projects: { example: {
        environment: 'test', connectionEnv: 'RW_INTEGRATION_SOURCE', assertions: [{ table: 'accounts', minimumRows: 2 }],
      } }, restoreTargets: {
        recovery: { environment: 'test', connectionEnv: 'RW_INTEGRATION_TARGET' },
        source: { environment: 'test', connectionEnv: 'RW_INTEGRATION_SOURCE' },
      } }),
      storageDirectory: root, postgresBinDirectory: directory,
    };
    manifest = await backup(loaded, 'example', options);
  }, 180_000);

  afterAll(async () => {
    if (native && nativeStarted && directory) {
      await runProcess(join(directory, 'pg_ctl'), ['-D', join(root, 'pgdata'), '-m', 'immediate', '-w', 'stop'], { timeoutMs: 30_000 });
    } else if (!native) await runProcess('docker', ['rm', '--force', '--volumes', name], { timeoutMs: 30_000 }).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
    delete process.env.RW_INTEGRATION_SOURCE;
    delete process.env.RW_INTEGRATION_TARGET;
    delete process.env.RW_INTEGRATION_ADMIN;
    delete process.env.RW_POSTGRES_TEST_IDENTITY;
  }, 40_000);

  it('backs up real schema/data and catalogs only completed artifacts', async () => {
    expect(manifest.bytes).toBeGreaterThan(0);
    expect((await listBackups(root, 'example'))[0]?.id).toBe(manifest.id);
    expect((await readdir(root)).filter((entry) => entry.endsWith('.partial'))).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain(sourceUrl);
    expect(await doctor(loaded, 'example', options)).toMatchObject({ serverMajor: major, sandboxReady: true });
  });

  it('restores and checks data inside an isolated container, then removes it', async () => {
    const report = await verify(loaded, manifest.id, options);
    expect(report.passed, JSON.stringify(report)).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'rows:public.accounts', passed: true }));
    expect(await status(loaded, 'example')).toMatchObject({ lastVerifiedBackup: { id: manifest.id }, latestVerification: { passed: true } });
    expect(await runProcess('docker', ['ps', '-aq', '--filter', 'label=org.restore-witness.sandbox=true'], options)).toBe('');
  }, 180_000);

  it('restores to an empty target and preserves constraints, views, and sequences', async () => {
    expect(await restore(loaded, manifest.id, 'recovery', options)).toMatchObject({ restored: true, verified: false });
    const target = connectionFromEnv('RW_INTEGRATION_TARGET');
    expect(await query(directory, target, 'SELECT count(*) FROM account_names', options)).toBe('2');
    expect(await query(directory, target, `INSERT INTO accounts (name) VALUES ('gamma') RETURNING id`, options)).toContain('3');
    await expect(query(directory, target, 'INSERT INTO orders (account_id) VALUES (999)', options)).rejects.toThrow('Tool failed');
    await expect(restore(loaded, manifest.id, 'recovery', options)).rejects.toThrow('not empty');
    await expect(restore(loaded, manifest.id, 'source', options)).rejects.toThrow('matches the backup source');
  }, 180_000);

  it('enforces custom Docker resource limits and records them in persisted reports', async () => {
    const sandboxResources = { memoryMiB: 640, cpus: 0.5, pidsLimit: 128 };
    await withSandbox(major, options, async (sandbox) => {
      const actual: unknown = JSON.parse(await runProcess('docker', ['inspect', sandbox.name, '--format', '{{json .HostConfig}}'], options));
      expect(actual).toMatchObject({ Memory: 640 * 1024 * 1024, MemorySwap: 640 * 1024 * 1024,
        NanoCpus: 500_000_000, PidsLimit: 128, NetworkMode: 'none', PortBindings: {}, Binds: null });
      expect(await sandbox.query('SELECT 1')).toBe('1');
    }, sandboxResources);
    const configured = { ...loaded, config: { ...loaded.config, sandboxResources } };
    expect(await verify(configured, manifest.id, options)).toMatchObject({ passed: true, sandboxResources });
    expect(await status(configured, 'example')).toMatchObject({ latestVerification: { sandboxResources } });
    expect(await runProcess('docker', ['ps', '-aq', '--filter', 'label=org.restore-witness.sandbox=true'], options)).toBe('');
  }, 180_000);

  it('reports failed application assertions without claiming recovery success', async () => {
    const failing = { ...loaded, config: configSchema.parse({ ...loaded.config, projects: {
      example: { ...loaded.config.projects.example, assertions: [{ table: 'accounts', minimumRows: 999 }] },
    } }) };
    const other = await backup(failing, 'example', options);
    const report = await verify(failing, other.id, options);
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'rows:public.accounts', passed: false }));
  }, 180_000);

  it('rejects corrupted artifacts before starting a sandbox', async () => {
    const artifact = join(root, manifest.id, 'backup.dump');
    const original = await readFile(artifact);
    await writeFile(artifact, original.subarray(0, original.length - 10));
    const report = await verify(loaded, manifest.id, options);
    expect(report.passed).toBe(false);
    expect(report.checks[0]?.detail).toContain('checksum');
    await expect(restore(loaded, manifest.id, 'recovery', options)).rejects.toThrow('checksum');
    await writeFile(artifact, original);
  });

  it.runIf(Boolean(process.env.RW_AGE_BIN_DIRECTORY))('creates an encrypted database backup and verifies it with the recovery identity', async () => {
    const encrypted = await encryptedFixture();
    const saved = await backup(encrypted, 'example', options);
    expect(saved.version).toBe(2);
    expect(await readdir(join(root, saved.id))).not.toContain('backup.dump');
    expect((await verify(encrypted, saved.id, options)).passed).toBe(true);
    expect((await readdir(root)).filter((name) => name.startsWith('.decrypt-'))).toEqual([]);
  }, 180_000);

  it.runIf(Boolean(process.env.RW_TEST_S3_ENDPOINT))('recovers a real database from S3 after deleting the original local backup', async () => {
    const encrypted = await encryptedFixture();
    const bucket = `rw-test-${randomUUID()}`;
    const endpoint = process.env.RW_TEST_S3_ENDPOINT ?? '';
    const remote: LoadedConfig = { ...encrypted, config: configSchema.parse({ ...encrypted.config, s3: {
      bucket, region: 'us-east-1', endpoint, forcePathStyle: true, allowInsecureLocalEndpoint: true,
      accessKeyEnv: 'RW_TEST_S3_ACCESS', secretKeyEnv: 'RW_TEST_S3_SECRET',
    } }) };
    const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true,
      credentials: { accessKeyId: process.env.RW_TEST_S3_ACCESS ?? '', secretAccessKey: process.env.RW_TEST_S3_SECRET ?? '' },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const saved = await backup(remote, 'example', options);
      expect(await pushBackup(remote, saved.id, options)).toMatchObject({ uploaded: true });
      await rm(join(root, saved.id), { recursive: true });
      const report = await withRemoteBackup(remote, 'example', saved.id, options, (temporary) => verify(temporary, saved.id, options));
      expect(report.passed, JSON.stringify(report)).toBe(true);
      await recordRemoteVerification(remote, saved, report, options);
      expect(await listRemoteBackups(remote, 'example', options)).toMatchObject([{ manifest: { id: saved.id }, verification: { passed: true } }]);
      expect(report.checks).toContainEqual(expect.objectContaining({ name: 'decryption', passed: true }));
      expect((await readdir(root)).filter((name) => name.startsWith('.remote-') || name.startsWith('.decrypt-'))).toEqual([]);
      await expect(readFile(join(root, saved.id, 'backup.dump.age'))).rejects.toThrow();
      // Force a multipart upload independently of the tiny database fixture.
      const largeId = randomUUID();
      const directory = join(root, largeId);
      await mkdir(directory, { mode: 0o700 });
      const plaintextPath = join(directory, 'large.fixture');
      await writeFile(plaintextPath, randomBytes(9 * 1024 * 1024));
      if (saved.version !== 2) throw new Error('Expected encrypted fixture.');
      const plainDigest = await artifactDigest(plaintextPath);
      const encryptedPath = join(directory, 'backup.dump.age');
      await encryptArtifact(remote, plaintextPath, encryptedPath, saved.encryption.recipient, options);
      await rm(plaintextPath);
      const cipherDigest = await artifactDigest(encryptedPath);
      const large: Manifest = { ...saved, id: largeId, ...cipherDigest,
        encryption: { ...saved.encryption, plaintextBytes: plainDigest.bytes, plaintextSha256: plainDigest.sha256 } };
      await atomicJson(join(directory, 'manifest.json'), large);
      expect(await pushBackup(remote, largeId, options)).toMatchObject({ uploaded: true });
      await rm(directory, { recursive: true });
      expect(await pullBackup(remote, 'example', largeId, options)).toMatchObject({ sha256: cipherDigest.sha256, bytes: cipherDigest.bytes });
      remote.config.projects.example!.remoteRetention = { timeZone: 'UTC', daily: 0, weekly: 0, monthly: 0 };
      // Two backups can share a completion timestamp; newest and verified are both protected.
      const extra = await backup(remote, 'example', options);
      await pushBackup(remote, extra.id, options);
      expect((await pruneRemote(remote, 'example', false, options)).protectedVerifiedId).toBe(saved.id);
      const pruned = await pruneRemote(remote, 'example', true, options);
      expect(pruned.keep.map((item) => item.backupId)).toContain(saved.id);
      expect(pruned.deleted).toContain(largeId);
      expect((await listRemoteBackups(remote, 'example', options)).some((entry) => entry.manifest.id === largeId)).toBe(false);
    } finally { client.destroy(); }
  }, 180_000);

  it('measures a source backup and isolated recovery drill, persisting timing evidence', async () => {
    const report = await drill(loaded, 'example', false, options);
    expect(report).toMatchObject({ passed: true, project: 'example', origin: 'local', uploadDurationMs: null });
    expect(report.backupDurationMs).toBeGreaterThan(0);
    expect(report.recoveryDurationMs).toBeGreaterThan(0);
    expect(report.recoveryPointAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(await readFile(join(root, 'drills', 'example', `${report.id}.json`), 'utf8'))).toEqual(report);
  }, 180_000);

  it('runs durable scheduled backups and verification, then applies local retention to actual dumps', async () => {
    const scheduled: LoadedConfig = { ...loaded, storageDirectory: join(root, 'scheduled'), config: configSchema.parse({ ...loaded.config, projects: {
      example: { ...loaded.config.projects.example, schedule: { timeZone: 'UTC', backupAt: '00:00', verifyAt: '00:00' }, retention: { daily: 0, weekly: 0, monthly: 0 } },
    } }) };
    const capacityLimited = { ...scheduled, config: configSchema.parse({ ...scheduled.config, minimumFreeBytes: Number.MAX_SAFE_INTEGER }) };
    await expect(backup(capacityLimited, 'example', options)).rejects.toThrow('configured minimum');
    expect(await listBackups(scheduled.storageDirectory, 'example')).toHaveLength(0);
    const obsolete = await backup(scheduled, 'example', options);
    await atomicJson(join(scheduled.storageDirectory, obsolete.id, 'manifest.json'), { ...obsolete, snapshotStartedAt: '2020-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:01Z' });
    const result = await tick(scheduled, 'example', options);
    expect(result.healthy, JSON.stringify(result)).toBe(true);
    expect(result.jobs).toHaveLength(2);
    const backupId = result.jobs.find((job) => job.kind === 'backup')?.backupId;
    expect(backupId).toBeTruthy();
    expect((await tick(scheduled, 'example', options)).jobs.find((job) => job.kind === 'backup')?.backupId).toBe(backupId);
    const preview = await prune(scheduled, 'example', false);
    expect(preview.remove.map((item) => item.backupId)).toEqual([obsolete.id]);
    expect(preview.protectedVerifiedId).toBe(backupId);
    const applied = await prune(scheduled, 'example', true);
    expect(applied.deleted).toEqual([obsolete.id]);
    expect((await listBackups(scheduled.storageDirectory, 'example')).map((item) => item.id)).toEqual([backupId]);
  }, 180_000);

  it('monitors actual restored dumps and detects corruption without querying the live source', async () => {
    const observed = { ...loaded, storageDirectory: join(root, 'monitored') };
    const saved = await backup(observed, 'example', options);
    expect((await monitor(observed, 'example')).alerts).toContainEqual({ code: 'verification-missing' });
    expect((await verify(observed, saved.id, options)).passed).toBe(true);
    expect((await monitor(observed, 'example')).healthy).toBe(true);
    const archive = join(observed.storageDirectory, saved.id, 'backup.dump');
    const contents = await readFile(archive); await writeFile(archive, contents.subarray(0, contents.length - 10));
    expect((await monitor(observed, 'example')).alerts).toContainEqual({ code: 'artifact-invalid', subject: saved.id });
  }, 180_000);

  async function encryptedFixture(): Promise<LoadedConfig> {
    const bin = process.env.RW_AGE_BIN_DIRECTORY;
    if (!bin) throw new Error('Encryption integration tests require RW_AGE_BIN_DIRECTORY.');
    const current = { ...loaded, ageBinDirectory: bin };
    const identity = join(root, `identity-${randomUUID()}.txt`);
    await runProcess(ageTool(current, 'age-keygen'), ['--output', identity], options);
    await chmod(identity, 0o600);
    process.env.RW_POSTGRES_TEST_IDENTITY = identity;
    const recipient = await runProcess(ageTool(current, 'age-keygen'), ['-y', identity], options);
    return { ...current, config: configSchema.parse({ ...loaded.config, projects: {
      example: { ...loaded.config.projects.example, encryption: { recipient, identityFileEnv: 'RW_POSTGRES_TEST_IDENTITY' } },
    } }) };
  }
});
