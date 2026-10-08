import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type LoadedConfig } from '../src/config.js';
import { catalogBytes, withStorageBudget } from '../src/quota.js';
import { runProcess } from '../src/process.js';
import { atomicJson, manifestSchema } from '../src/storage.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<LoadedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'rw-quota-')); roots.push(root);
  return { config: configSchema.parse({ version: 1, projects: { example: { environment: 'test', connectionEnv: 'DB' } } }), storageDirectory: root, postgresBinDirectory: undefined };
}
describe('catalog storage quota and streaming output', () => {
  it('measures actual artifact bytes including unconfigured projects and excludes scratch files', async () => {
    const loaded = await fixture(); const id = randomUUID(); await mkdir(join(loaded.storageDirectory, id));
    await atomicJson(join(loaded.storageDirectory, id, 'manifest.json'), { version: 1, format: 'postgres-custom', id, project: 'other', environment: 'test',
      createdAt: new Date().toISOString(), serverMajor: 16, sourceFingerprint: 'a'.repeat(64), sha256: 'b'.repeat(64), bytes: 1, assertions: [] });
    await writeFile(join(loaded.storageDirectory, id, 'backup.dump'), '12345');
    await writeFile(join(loaded.storageDirectory, 'scratch'), 'not managed');
    expect(await catalogBytes(loaded.storageDirectory)).toBe(5);
    loaded.config.maximumStorageBytes = 5;
    await expect(withStorageBudget(loaded, async () => true)).rejects.toThrow('exhausted');
    loaded.config.maximumStorageBytes = 9;
    expect(await withStorageBudget(loaded, async (remaining) => remaining)).toBe(4);
  });
  it('serializes writers across projects and releases the quota lock after errors', async () => {
    const loaded = await fixture();
    await expect(withStorageBudget(loaded, async () => {
      await expect(withStorageBudget(loaded, async () => true)).rejects.toThrow('locked');
      throw new Error('cancelled fixture');
    })).rejects.toThrow('cancelled fixture');
    expect(await withStorageBudget(loaded, async () => true)).toBe(true);
  });
  it('streams output beyond capture limit privately without buffering the archive', { timeout: 15000 }, async () => {
    const loaded = await fixture(); const path = join(loaded.storageDirectory, 'large');
    await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(2*1024*1024,42))'], { timeoutMs: 10000, outputFile: { path, maximumBytes: 2*1024*1024 } });
    expect((await stat(path)).size).toBe(2*1024*1024);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });
  it('stops output at the byte ceiling and refuses overwriting an existing file', { timeout: 15000 }, async () => {
    const loaded = await fixture(); const path = join(loaded.storageDirectory, 'bounded');
    await expect(runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(1024*1024))'], { timeoutMs: 10000, outputFile: { path, maximumBytes: 1000 } })).rejects.toThrow('budget');
    expect((await stat(path)).size).toBeLessThanOrEqual(1000);
    await writeFile(path, 'keep');
    await expect(runProcess(process.execPath, ['-e', 'console.log("overwrite")'], { timeoutMs: 10000, outputFile: { path, maximumBytes: 1000 } })).rejects.toThrow('protected storage');
    expect(await readFile(path, 'utf8')).toBe('keep');
  });
  it('rejects invalid quota and snapshot configuration', () => {
    const base = { version: 1, projects: { example: { environment: 'test', connectionEnv: 'DB' } } };
    expect(configSchema.safeParse({ ...base, maximumStorageBytes: 0 }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, maximumStorageBytes: 128*1024*1024 }).success).toBe(true);
    expect(manifestSchema.safeParse({ version: 1, format: 'postgres-custom', id: randomUUID(), project: 'example', environment: 'test',
      serverMajor: 17, sourceFingerprint: 'a'.repeat(64), bytes: 1, sha256: 'b'.repeat(64), assertions: [],
      snapshotStartedAt: '2026-10-07T00:01:00Z', createdAt: '2026-10-07T00:00:00Z' }).success).toBe(false);
  });
});
