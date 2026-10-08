import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { sandboxResourcesSchema, type SandboxResources } from './config.js';
import { WitnessError } from './errors.js';
import { runProcess, type ProcessOptions } from './process.js';

export interface Sandbox {
  readonly name: string;
  readonly imageId: string;
  readonly resources: SandboxResources;
  query(sql: string): Promise<string>;
  restore(path: string): Promise<void>;
}

export async function withSandbox<T>(major: number, options: ProcessOptions, operation: (sandbox: Sandbox) => Promise<T>, requestedResources: SandboxResources = sandboxResourcesSchema.parse({})): Promise<T> {
  const parsed = sandboxResourcesSchema.safeParse(requestedResources);
  if (!parsed.success) throw new WitnessError('Invalid sandbox resource limits.');
  const resources = parsed.data;
  const name = `restore-witness-${randomUUID()}`;
  // Require an explicitly pre-pulled image; never download images during recovery.
  const image = await runProcess('docker', ['image', 'inspect', `postgres:${major}`, '--format', '{{.Id}}'], options);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new WitnessError('Cannot identify PostgreSQL sandbox image.');
  let created = false;
  try {
    // Use the inspected immutable image ID, not a tag that could move between calls.
    await runProcess('docker', ['create', '--name', name,
      '--label', 'org.restore-witness.sandbox=true', '--network', 'none',
      '--memory', `${resources.memoryMiB}m`, '--memory-swap', `${resources.memoryMiB}m`,
      '--cpus', String(resources.cpus), '--pids-limit', String(resources.pidsLimit),
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', image,
      'postgres', '-c', 'listen_addresses=', '-c', 'max_connections=10', '-c', 'shared_buffers=32MB',
    ], options);
    created = true;
    const hostConfig = await runProcess('docker', ['inspect', name, '--format', '{{json .HostConfig}}'], options);
    let settings: unknown;
    try { settings = JSON.parse(hostConfig); } catch { throw new WitnessError('Cannot inspect sandbox resource limits.'); }
    const expected = z.object({
      Memory: z.literal(resources.memoryMiB * 1024 * 1024),
      MemorySwap: z.literal(resources.memoryMiB * 1024 * 1024),
      NanoCpus: z.literal(resources.cpus * 1_000_000_000),
      PidsLimit: z.literal(resources.pidsLimit),
      NetworkMode: z.literal('none'),
    });
    if (!expected.safeParse(settings).success) throw new WitnessError('Docker sandbox resource or network limits do not match configuration.');
    await runProcess('docker', ['start', name], options);
    const readyUntil = Date.now() + Math.min(options.timeoutMs, 60_000);
    while (true) {
      try {
        await runProcess('docker', ['exec', name, 'sh', '-c', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'], options);
        break;
      } catch {
        if (options.signal?.aborted || Date.now() >= readyUntil) throw new WitnessError('PostgreSQL sandbox did not become ready.');
        await delay(200, undefined, { signal: options.signal });
      }
    }
    await runProcess('docker', ['exec', name, 'createdb', '-U', 'postgres', 'witness'], options);
    return await operation({
      name, imageId: image, resources,
      query: (sql) => runProcess('docker', ['exec', name, 'psql', '-X', '-U', 'postgres', '-d', 'witness', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], options),
      restore: async (path) => {
        await runProcess('docker', ['exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', 'witness', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { ...options, inputFile: path });
      },
    });
  } finally {
    // Cleanup must work after cancellation. A cleanup failure invalidates success.
    if (created) await runProcess('docker', ['rm', '--force', '--volumes', name], { timeoutMs: 30_000 });
    else {
      // create may have completed server-side while the client timed out.
      await runProcess('docker', ['rm', '--force', '--volumes', name], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }
}
