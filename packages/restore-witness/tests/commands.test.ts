import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/commands.js';

describe('CLI contract', () => {
  it.each([[], ['--help'], ['-h']].map((args) => ({ args })))('shows help for $args', async ({ args }) => {
    const result = await runCommand(args, '0.5.0-alpha.1');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: restore-witness');
    expect(result.stdout).toContain('Retention defaults to a dry run');
    expect(result.stderr).toBe('');
  });

  it('initializes configuration once and never overwrites it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rw-cli-'));
    const path = join(root, 'restore-witness.json');
    try {
      expect((await runCommand(['init', '--config', path], '0.5.0-alpha.1')).exitCode).toBe(0);
      const before = await readFile(path, 'utf8');
      expect((await runCommand(['init', '--config', path], '0.5.0-alpha.1')).exitCode).toBe(1);
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(before).toContain('EXAMPLE_DATABASE_URL');
      expect((await runCommand(['status', 'example', '--config', path], '0.5.0-alpha.1')).stdout).toContain('"backupCount": 0');
      const history = await runCommand(['compact-jobs', 'example', '--before', '2026-01-01', '--config', path], '0.5.0-alpha.1');
      expect(history.exitCode).toBe(0);
      expect(JSON.parse(history.stdout)).toMatchObject({ project: 'example', beforeDate: '2026-01-01', dryRun: true, candidates: [], removed: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([['--version'], ['-v']].map((args) => ({ args })))('shows version for $args', async ({ args }) => {
    expect(await runCommand(args, '0.5.0-alpha.1')).toEqual({
      exitCode: 0, stdout: '0.5.0-alpha.1\n', stderr: '',
    });
  });

  it.each([
    ['monitor'], ['monitor', 'example', '--notify', '--notify'], ['status', 'example', '--notify'], ['backup', 'example', '--apply'], ['prune'], ['tick'], ['backup'], ['restore'], ['--unknown'], ['--version', '--help'],
    ['--help', 'restore'], [''], ['backup', 'example', '--target', 'recovery'],
    ['restore', 'id'], ['init', 'extra'], ['list', 'example', '--config', 'a', '--config', 'b'],
    ['verify', 'id', '--remote'], ['push', 'id', '--remote'], ['pull', 'id'],
    ['compact-jobs', 'example'], ['jobs', 'example', '--before', '2026-01-01'], ['backup', 'example', '--before', '2026-01-01'],
    ['list', 'example', '--project', 'example'], ['verify', 'id', '--project', 'example'],
  ].map((args) => ({ args })))('rejects unsupported inputs $args without reporting success', async ({ args }) => {
    const result = await runCommand(args, '0.5.0-alpha.1');
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported command');
  });
});
