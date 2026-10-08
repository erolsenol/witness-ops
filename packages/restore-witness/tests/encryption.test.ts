import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, type LoadedConfig } from '../src/config.js';
import { ageTool, encryptArtifact, withPlaintext } from '../src/encryption.js';
import { runProcess } from '../src/process.js';
import { artifactDigest, type Manifest } from '../src/storage.js';

const bin = process.env.RW_AGE_BIN_DIRECTORY;
describe.runIf(Boolean(bin))('real age encryption', { timeout: 30_000 }, () => {
  let root: string;
  let loaded: LoadedConfig;
  let manifest: Manifest;
  let encrypted: string;
  const options = { timeoutMs: 10_000 };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rw-age-'));
    const identity = join(root, 'identity.txt');
    process.env.RW_TEST_AGE_IDENTITY = identity;
    const base: LoadedConfig = { config: configSchema.parse({ version: 1, projects: { example: { environment: 'test', connectionEnv: 'DB' } } }), storageDirectory: root, postgresBinDirectory: undefined, ...(bin ? { ageBinDirectory: bin } : {}) };
    await runProcess(ageTool(base, 'age-keygen'), ['--output', identity], options);
    await chmod(identity, 0o600);
    const recipient = await runProcess(ageTool(base, 'age-keygen'), ['-y', identity], options);
    loaded = { ...base, config: configSchema.parse({ version: 1, projects: { example: { environment: 'test', connectionEnv: 'DB', encryption: { recipient, identityFileEnv: 'RW_TEST_AGE_IDENTITY' } } } }) };
    const plain = join(root, 'original.dump');
    await writeFile(plain, 'private database contents');
    const plaintext = await artifactDigest(plain);
    encrypted = join(root, 'encrypted.age');
    await encryptArtifact(loaded, plain, encrypted, recipient, options);
    const cipher = await artifactDigest(encrypted);
    manifest = { version: 2, id: randomUUID(), project: 'example', environment: 'test', createdAt: new Date().toISOString(), serverMajor: 16, sourceFingerprint: 'a'.repeat(64), format: 'postgres-custom-age', ...cipher, assertions: [], encryption: { recipient, plaintextSha256: plaintext.sha256, plaintextBytes: plaintext.bytes } };
  });
  afterAll(async () => { delete process.env.RW_TEST_AGE_IDENTITY; if (root) await rm(root, { recursive: true, force: true }); });

  it('round-trips content and removes temporary plaintext', async () => {
    expect((await readFile(encrypted, 'utf8')).includes('private database contents')).toBe(false);
    expect(await withPlaintext(loaded, manifest, encrypted, options, (path) => readFile(path, 'utf8'))).toBe('private database contents');
    expect((await readdir(root)).filter((name) => name.startsWith('.decrypt-'))).toEqual([]);
  });
  it('rejects corrupted ciphertext even if its outer checksum is replaced', async () => {
    const corrupted = join(root, 'corrupted.age');
    const bytes = await readFile(encrypted);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await writeFile(corrupted, bytes);
    await expect(withPlaintext(loaded, manifest, corrupted, options, async () => true)).rejects.toThrow('Tool failed');
    expect((await readdir(root)).filter((name) => name.startsWith('.decrypt-'))).toEqual([]);
  });
  it('rejects a wrong identity and protects private key permissions', async () => {
    const other = join(root, 'other-key.txt');
    await runProcess(ageTool(loaded, 'age-keygen'), ['--output', other], options);
    await chmod(other, 0o600);
    process.env.RW_TEST_AGE_IDENTITY = other;
    await expect(withPlaintext(loaded, manifest, encrypted, options, async () => true)).rejects.toThrow('Tool failed');
    await chmod(other, 0o644);
    await expect(withPlaintext(loaded, manifest, encrypted, options, async () => true)).rejects.toThrow('private file');
    process.env.RW_TEST_AGE_IDENTITY = join(root, 'identity.txt');
  });
  it('removes plaintext after application failure', async () => {
    await expect(withPlaintext(loaded, manifest, encrypted, options, async () => { throw new Error('application failure'); })).rejects.toThrow('application failure');
    expect((await readdir(root)).filter((name) => name.startsWith('.decrypt-'))).toEqual([]);
  });
});
