import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedConfig } from './config.js';
import { WitnessError } from './errors.js';
import { artifactName, backupIdSchema, loadManifest, withStorageQuotaLock } from './storage.js';

// Count actual committed artifact sizes, including projects absent from current config.
export async function catalogBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  let bytes = 0;
  for (const entry of entries) {
    if (!backupIdSchema.safeParse(entry.name).success) continue;
    const manifest = await loadManifest(root, entry.name);
    const info = await lstat(join(root, entry.name, artifactName(manifest)));
    if (!info.isFile() || info.isSymbolicLink()) throw new WitnessError('Cannot measure unsafe catalog artifact.');
    bytes += info.size;
    if (!Number.isSafeInteger(bytes)) throw new WitnessError('Catalog size exceeds supported limits.');
  }
  return bytes;
}

export async function withStorageBudget<T>(loaded: LoadedConfig, operation: (remainingBytes: number) => Promise<T>): Promise<T> {
  // Always lock, including unlimited clients, so changing configuration cannot bypass serialization.
  return withStorageQuotaLock(loaded.storageDirectory, async () => {
    const limit = loaded.config.maximumStorageBytes;
    const remaining = limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - await catalogBytes(loaded.storageDirectory));
    if (remaining === 0) throw new WitnessError('Local backup storage quota is exhausted. Preview retention before freeing space.');
    return operation(remaining);
  });
}
