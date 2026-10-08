import { lstat, mkdtemp, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedConfig } from './config.js';
import { WitnessError } from './errors.js';
import { runProcess, type ProcessOptions } from './process.js';
import { artifactDigest, type Manifest } from './storage.js';

export function ageTool(loaded: LoadedConfig, tool: 'age' | 'age-keygen' = 'age'): string {
  return loaded.ageBinDirectory ? join(loaded.ageBinDirectory, tool) : tool;
}

export async function checkAge(loaded: LoadedConfig, options: ProcessOptions): Promise<void> {
  const version = await runProcess(ageTool(loaded), ['--version'], options);
  if (!/^v?1\.\d+\.\d+/.test(version)) throw new WitnessError('This release requires age version 1.x.');
}

export async function encryptArtifact(loaded: LoadedConfig, source: string, output: string, recipient: string, options: ProcessOptions, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<void> {
  await runProcess(ageTool(loaded), ['--encrypt', '--recipient', recipient], { ...options, inputFile: source, outputFile: { path: output, maximumBytes } });
  const file = await open(output, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

export async function withPlaintext<T>(loaded: LoadedConfig, manifest: Manifest, artifact: string, options: ProcessOptions, operation: (path: string) => Promise<T>): Promise<T> {
  if (manifest.version === 1) return operation(artifact);
  const project = loaded.config.projects[manifest.project];
  const encryption = project?.encryption;
  if (!encryption) throw new WitnessError('Encrypted recovery requires a configured identityFileEnv for this project.');
  const identityPath = process.env[encryption.identityFileEnv];
  if (!identityPath) throw new WitnessError('Recovery identity file environment variable is missing.');
  const identityInfo = await lstat(identityPath).catch(() => undefined);
  if (!identityInfo?.isFile() || identityInfo.size > 1024 * 1024 || (identityInfo.mode & 0o077) !== 0) throw new WitnessError('Recovery identity must be a regular private file (mode 0600 or stricter; at most 1 MiB).');
  const space = await statfs(loaded.storageDirectory);
  if (space.bavail * space.bsize < manifest.encryption.plaintextBytes + 128 * 1024 * 1024) throw new WitnessError('Insufficient free disk space for temporary decryption.');
  const temporary = await mkdtemp(join(loaded.storageDirectory, '.decrypt-'));
  const output = join(temporary, 'backup.dump');
  try {
    const handle = await open(output, 'wx', 0o600);
    await handle.close();
    await runProcess(ageTool(loaded), ['--decrypt', '--identity', identityPath, '--output', output], { ...options, inputFile: artifact });
    const digest = await artifactDigest(output, options.signal);
    if (digest.bytes !== manifest.encryption.plaintextBytes || digest.sha256 !== manifest.encryption.plaintextSha256) throw new WitnessError('Decrypted backup does not match its manifest.');
    return await operation(output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
