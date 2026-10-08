import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withSandbox } from '../src/sandbox.js';
import { runProcess } from '../src/process.js';
import type { SandboxResources } from '../src/config.js';

vi.mock('../src/process.js', () => ({ runProcess: vi.fn() }));
const run = vi.mocked(runProcess);
const imageId = `sha256:${'a'.repeat(64)}`;
const resources: SandboxResources = { memoryMiB: 768, cpus: 0.5, pidsLimit: 64 };
function hostConfig(limits: SandboxResources): string {
  return JSON.stringify({ Memory: limits.memoryMiB * 1024 * 1024, MemorySwap: limits.memoryMiB * 1024 * 1024,
    NanoCpus: limits.cpus * 1_000_000_000, PidsLimit: limits.pidsLimit, NetworkMode: 'none' });
}
beforeEach(() => {
  run.mockReset();
  run.mockImplementation(async (_tool, args) => {
    if (args[0] === 'image') return imageId;
    if (args[0] === 'inspect') return hostConfig(resources);
    return '';
  });
});

describe('sandbox limits and lifecycle', () => {
  it('restores with stdin and immutable image, then removes container and volumes', async () => {
    const result = await withSandbox(18, { timeoutMs: 1000 }, async (sandbox) => {
      expect(sandbox.resources).toEqual(resources);
      await sandbox.restore('/private/backup.dump');
      return 'restored';
    }, resources);
    expect(result).toBe('restored');
    const create = run.mock.calls.find(([, args]) => args[0] === 'create')?.[1];
    expect(create).toEqual(expect.arrayContaining(['--memory', '768m', '--memory-swap', '768m', '--cpus', '0.5', '--pids-limit', '64', '--network', 'none', imageId]));
    expect(create).not.toContain('--mount');
    expect(create).not.toContain('--privileged');
    const streamed = run.mock.calls.find(([, args]) => args.includes('pg_restore'));
    expect(streamed?.[2].inputFile).toBe('/private/backup.dump');
    expect(streamed?.[1]).not.toContain('/private/backup.dump');
    expect(run.mock.lastCall?.[1]).toEqual(['rm', '--force', '--volumes', create?.[2]]);
  });
  it('keeps default limits for existing callers', async () => {
    run.mockImplementation(async (_tool, args) => args[0] === 'image' ? imageId : args[0] === 'inspect'
      ? hostConfig({ memoryMiB: 512, cpus: 1, pidsLimit: 256 }) : '');
    await withSandbox(16, { timeoutMs: 1000 }, async (sandbox) => {
      expect(sandbox.resources).toEqual({ memoryMiB: 512, cpus: 1, pidsLimit: 256 });
    });
  });
  it.each(['Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'NetworkMode'])('rejects mismatched %s before database start and cleans up', async (field) => {
    run.mockImplementation(async (_tool, args) => {
      if (args[0] === 'image') return imageId;
      if (args[0] === 'inspect') return JSON.stringify({ ...JSON.parse(hostConfig(resources)) as Record<string, unknown>, [field]: null });
      return '';
    });
    const operation = vi.fn();
    await expect(withSandbox(17, { timeoutMs: 1000 }, operation, resources)).rejects.toThrow('do not match');
    expect(operation).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([, args]) => args[0] === 'start')).toBe(false);
    expect(run.mock.lastCall?.[1].slice(0, 3)).toEqual(['rm', '--force', '--volumes']);
  });
  it('cleans up after invalid inspection JSON', async () => {
    run.mockImplementation(async (_tool, args) => args[0] === 'image' ? imageId : args[0] === 'inspect' ? 'invalid' : '');
    await expect(withSandbox(18, { timeoutMs: 1000 }, async () => true, resources)).rejects.toThrow('Cannot inspect');
    expect(run.mock.lastCall?.[1][0]).toBe('rm');
  });
  it('cleans up after cancellation using an independent timeout', async () => {
    const controller = new AbortController();
    await expect(withSandbox(18, { timeoutMs: 1000, signal: controller.signal }, async () => {
      controller.abort();
      throw new Error('Restore cancelled');
    }, resources)).rejects.toThrow('Restore cancelled');
    expect(run.mock.lastCall?.[2]).toEqual({ timeoutMs: 30_000 });
  });
  it('does not report success when cleanup fails', async () => {
    run.mockImplementation(async (_tool, args) => {
      if (args[0] === 'image') return imageId;
      if (args[0] === 'inspect') return hostConfig(resources);
      if (args[0] === 'rm') throw new Error('Cleanup failed');
      return '';
    });
    await expect(withSandbox(18, { timeoutMs: 1000 }, async () => true, resources)).rejects.toThrow('Cleanup failed');
  });
  it('rejects invalid resources without talking to Docker', async () => {
    await expect(withSandbox(18, { timeoutMs: 1000 }, async () => true, { ...resources, cpus: Infinity })).rejects.toThrow('Invalid sandbox');
    expect(run).not.toHaveBeenCalled();
  });
});
