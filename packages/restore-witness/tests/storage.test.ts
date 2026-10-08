import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactDigest, atomicJson, backupDirectory, listBackups, loadManifest, loadVerification, manifestSchema, withProjectLock } from '../src/storage.js';

const directories: string[] = [];
async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rw-storage-'));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('backup storage', () => {
  it('reads historical reports and preserves recorded resource limits independently of config', async () => {
    const root = await fixture();
    const id = randomUUID();
    const manifest = manifestSchema.parse({ id, project: 'example', environment: 'test', createdAt: new Date().toISOString(),
      serverMajor: 18, sourceFingerprint: 'a'.repeat(64), bytes: 1, sha256: 'b'.repeat(64), version: 1, format: 'postgres-custom' });
    const directory = backupDirectory(root, id);
    await mkdir(directory);
    const report = { version: 1, backupId: id, project: 'example', verifiedAt: new Date().toISOString(), durationMs: 1,
      passed: true, checks: [{ name: 'restore', passed: true, detail: 'Restored.' }] };
    const path = join(directory, 'verification.json');
    await atomicJson(path, report);
    expect((await loadVerification(root, manifest))?.sandboxResources).toBeUndefined();
    const sandboxResources = { memoryMiB: 1024, cpus: 2, pidsLimit: 128 };
    await atomicJson(path, { ...report, sandboxResources });
    expect((await loadVerification(root, manifest))?.sandboxResources).toEqual(sandboxResources);
    await atomicJson(path, { ...report, sandboxResources: { ...sandboxResources, pidsLimit: -1 } });
    await expect(loadVerification(root, manifest)).rejects.toThrow('Invalid verification report');
    await atomicJson(path, { ...report, sandboxResources: { cpus: 2 } });
    await expect(loadVerification(root, manifest)).rejects.toThrow('Invalid verification report');
  });
  it('rejects path traversal before reading disk', () => {
    expect(() => backupDirectory('/tmp', '../escape')).toThrow('Invalid backup');
  });
  it('ignores unfinished backups', async () => {
    const root = await fixture();
    await mkdir(join(root, `.${randomUUID()}.partial`));
    expect(await listBackups(root, 'example')).toEqual([]);
  });
  it('rejects symbolic links for artifacts and backup directories', async () => {
    const root = await fixture();
    await writeFile(join(root, 'real'), 'data');
    await symlink(join(root, 'real'), join(root, 'linked'));
    await expect(artifactDigest(join(root, 'linked'))).rejects.toThrow('unsafe');
    const id = randomUUID();
    await symlink(root, join(root, id));
    await expect(loadManifest(root, id)).rejects.toThrow('unsafe');
  });
  it('streams accurate checksum and size', async () => {
    const root = await fixture();
    await writeFile(join(root, 'artifact'), 'hello');
    expect(await artifactDigest(join(root, 'artifact'))).toEqual({ bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
  });
  it('releases a lock after failure and prevents concurrent jobs', async () => {
    const root = await fixture();
    await expect(withProjectLock(root, 'example', async () => {
      await expect(withProjectLock(root, 'example', async () => true)).rejects.toThrow('locked');
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    expect(await withProjectLock(root, 'example', async () => true)).toBe(true);
  });
  it('writes metadata without leaving partial files', async () => {
    const root = await fixture();
    await atomicJson(join(root, 'manifest.json'), { version: 1 });
    expect(await listBackups(root, 'example')).toEqual([]);
  });
});
