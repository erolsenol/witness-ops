import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { selectProject, type LoadedConfig, type SandboxResources } from './config.js';
import { WitnessError, safeMessage } from './errors.js';
import { checkAge, encryptArtifact, withPlaintext } from './encryption.js';
import { checkVersions, connectionFromEnv, parseInteger, pgTool, query, quoteIdentifier, targetObjectCountSql, userTableCountSql } from './postgres.js';
import { runProcess, type ProcessOptions } from './process.js';
import { withSandbox } from './sandbox.js';
import { withStorageBudget } from './quota.js';
import { artifactDigest, atomicJson, backupDirectory, listBackups, loadManifest, loadVerification, validateArtifact, withProjectLock, type Manifest, type VerificationCheck, type VerificationReport } from './storage.js';

export async function availableBytes(directory: string): Promise<number> {
  let path = directory;
  while (true) {
    try { const info = await statfs(path); return info.bavail * info.bsize; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly project: string;
  readonly serverMajor: number;
  readonly clientVersionsMatch: boolean;
  readonly freeBytes: number;
  readonly sandboxReady: boolean;
  readonly action?: string;
}

export async function doctor(loaded: LoadedConfig, projectId: string, options: ProcessOptions): Promise<DoctorReport> {
  const project = selectProject(loaded.config, projectId);
  const connection = connectionFromEnv(project.connectionEnv);
  const major = await checkVersions(loaded.postgresBinDirectory, connection, options);
  if (project.encryption) await checkAge(loaded, options);
  const freeBytes = await availableBytes(loaded.storageDirectory);
  if (freeBytes < loaded.config.minimumFreeBytes) throw new WitnessError('Free backup storage is below the configured minimum.');
  let sandboxReady = false;
  try {
    await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], options);
    await runProcess('docker', ['image', 'inspect', `postgres:${major}`, '--format', '{{.Id}}'], options);
    sandboxReady = true;
  } catch {
    if (options.signal?.aborted) throw new WitnessError('Operation cancelled.');
  }
  return { healthy: sandboxReady, project: projectId, serverMajor: major, clientVersionsMatch: true, freeBytes, sandboxReady,
    ...(sandboxReady ? {} : { action: `Start Docker and pull postgres:${major} to enable verification.` }) };
}

export async function backup(loaded: LoadedConfig, projectId: string, options: ProcessOptions): Promise<Manifest> {
  const project = selectProject(loaded.config, projectId);
  const connection = connectionFromEnv(project.connectionEnv);
  return withProjectLock(loaded.storageDirectory, projectId, () => withStorageBudget(loaded, async (remainingBytes) => {
    const serverMajor = await checkVersions(loaded.postgresBinDirectory, connection, options);
    if (project.encryption) await checkAge(loaded, options);
    const freeBytes = await availableBytes(loaded.storageDirectory);
    if (freeBytes <= loaded.config.minimumFreeBytes) throw new WitnessError('Free backup storage is below the configured minimum.');
    const scratchCapacity = Math.floor((freeBytes - loaded.config.minimumFreeBytes) / (project.encryption ? 2 : 1));
    const capacity = Math.min(remainingBytes, scratchCapacity);
    const id = randomUUID();
    const temporary = join(loaded.storageDirectory, `.${id}.partial`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const path = join(temporary, 'backup.dump');
      const snapshotStartedAt = new Date().toISOString();
      await runProcess(pgTool(loaded.postgresBinDirectory, 'pg_dump'), ['--no-password', '--format=custom'], { ...options, env: { ...connection.env, PGOPTIONS: '-c default_transaction_read_only=on' }, outputFile: { path, maximumBytes: capacity } });
      const digest = await artifactDigest(path, options.signal);
      if (digest.bytes === 0) throw new WitnessError('PostgreSQL produced an empty backup.');
      const handle = await open(path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      const fields = {
        id, project: projectId, environment: project.environment,
        createdAt: new Date().toISOString(), snapshotStartedAt, serverMajor, sourceFingerprint: connection.fingerprint,
        assertions: project.assertions,
      };
      let manifest: Manifest;
      if (project.encryption) {
        const encrypted = join(temporary, 'backup.dump.age');
        await encryptArtifact(loaded, path, encrypted, project.encryption.recipient, options, capacity);
        const ciphertext = await artifactDigest(encrypted, options.signal);
        manifest = { ...fields, version: 2, format: 'postgres-custom-age', ...ciphertext,
          encryption: { recipient: project.encryption.recipient, plaintextSha256: digest.sha256, plaintextBytes: digest.bytes } };
        await rm(path);
      } else manifest = { ...fields, version: 1, format: 'postgres-custom', ...digest };
      await atomicJson(join(temporary, 'manifest.json'), manifest);
      await rename(temporary, backupDirectory(loaded.storageDirectory, id));
      return manifest;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }));
}

export async function verify(loaded: LoadedConfig, id: string, options: ProcessOptions): Promise<VerificationReport> {
  const manifest = await loadManifest(loaded.storageDirectory, id);
  selectProject(loaded.config, manifest.project);
  return withProjectLock(loaded.storageDirectory, manifest.project, async () => {
    const start = Date.now();
    const checks: VerificationCheck[] = [];
    let imageId: string | undefined;
    let sandboxResources: SandboxResources | undefined;
    try {
      const path = await validateArtifact(loaded.storageDirectory, manifest, options.signal);
      checks.push({ name: 'artifact-integrity', passed: true, detail: 'SHA-256 and size match.' });
      await withPlaintext(loaded, manifest, path, options, (plaintext) => withSandbox(manifest.serverMajor, options, async (sandbox) => {
        if (manifest.version === 2) checks.push({ name: 'decryption', passed: true, detail: 'age authentication and plaintext checksum passed.' });
        imageId = sandbox.imageId;
        sandboxResources = sandbox.resources;
        checks.push({ name: 'sandbox-limits', passed: true, detail: 'Docker configuration matches memory, CPU, process and network limits; swap is disabled.' });
        await sandbox.restore(plaintext);
        checks.push({ name: 'restore', passed: true, detail: 'Archive restored in a single transaction.' });
        const tableCount = parseInteger(await sandbox.query(userTableCountSql));
        checks.push({ name: 'catalog', passed: true, detail: `${tableCount} user tables restored. This is not a source row-count comparison.` });
        for (const assertion of manifest.assertions) {
          const rows = parseInteger(await sandbox.query(`SELECT count(*) FROM ${quoteIdentifier(assertion.schema)}.${quoteIdentifier(assertion.table)}`));
          checks.push({ name: `rows:${assertion.schema}.${assertion.table}`, passed: rows >= assertion.minimumRows, detail: `${rows} rows; minimum ${assertion.minimumRows}.` });
        }
      }, loaded.config.sandboxResources));
      checks.push({ name: 'sandbox-cleanup', passed: true, detail: 'Temporary container and anonymous volumes removed.' });
    } catch (error) {
      checks.push({ name: 'operation', passed: false, detail: safeMessage(error) });
    }
    const report: VerificationReport = {
      version: 1, backupId: id, project: manifest.project, verifiedAt: new Date().toISOString(),
      durationMs: Date.now() - start, passed: checks.every((check) => check.passed), checks,
      ...(imageId ? { imageId } : {}),
      ...(sandboxResources ? { sandboxResources } : {}),
    };
    await atomicJson(join(backupDirectory(loaded.storageDirectory, id), 'verification.json'), report);
    return report;
  });
}

export async function restore(loaded: LoadedConfig, id: string, targetId: string, options: ProcessOptions, targetLockDirectory = loaded.storageDirectory): Promise<unknown> {
  const manifest = await loadManifest(loaded.storageDirectory, id);
  selectProject(loaded.config, manifest.project);
  const target = loaded.config.restoreTargets[targetId];
  if (!target) throw new WitnessError('Unknown restore target. Only explicitly configured development/test targets are allowed.');
  const connection = connectionFromEnv(target.connectionEnv);
  if (connection.fingerprint === manifest.sourceFingerprint) throw new WitnessError('Restore target matches the backup source.');
  // Lock both project and target to prevent concurrent restores from different projects.
  return withProjectLock(loaded.storageDirectory, manifest.project, () => withProjectLock(targetLockDirectory, `target-${connection.fingerprint.slice(0, 32)}`, async () => {
    const path = await validateArtifact(loaded.storageDirectory, manifest, options.signal);
    const major = await checkVersions(loaded.postgresBinDirectory, connection, options);
    if (major !== manifest.serverMajor) throw new WitnessError('Restore target major version must match the backup.');
    if (parseInteger(await query(loaded.postgresBinDirectory, connection, targetObjectCountSql, options)) !== 0) throw new WitnessError('Restore target is not empty. Existing objects will not be overwritten.');
    await withPlaintext(loaded, manifest, path, options, (plaintext) => runProcess(pgTool(loaded.postgresBinDirectory, 'pg_restore'), ['--no-password', '--dbname', connection.env.PGDATABASE ?? '', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', plaintext], { ...options, env: connection.env }));
    return { backupId: id, target: targetId, restored: true, verified: false };
  }));
}

export async function status(loaded: LoadedConfig, project: string): Promise<unknown> {
  selectProject(loaded.config, project);
  const backups = await listBackups(loaded.storageDirectory, project);
  const latest = backups[0];
  let latestVerification: VerificationReport | null = null;
  let lastVerifiedBackup: Manifest | null = null;
  for (const item of backups) {
    const report = await loadVerification(loaded.storageDirectory, item);
    if (report && (!latestVerification || report.verifiedAt > latestVerification.verifiedAt)) latestVerification = report;
    if (report?.passed && !lastVerifiedBackup) lastVerifiedBackup = item;
  }
  return { project, backupCount: backups.length, latestBackup: latest ?? null,
    backupAgeSeconds: latest ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.createdAt)) / 1000)) : null,
    latestVerification, lastVerifiedBackup };
}
