import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/process.js';

describe('bounded subprocess execution', () => {
  it('does not expose stderr containing credentials', { timeout: 15_000 }, async () => {
    await expect(runProcess(process.execPath, ['-e', 'process.stderr.write("password=secret"); process.exit(1)'], { timeoutMs: 10_000 })).rejects.toThrow('Tool failed');
  });
  it('passes literal arguments without a shell', { timeout: 15_000 }, async () => {
    expect(await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', '$(echo injected)'], { timeoutMs: 10_000 })).toBe('$(echo injected)');
  });
  it('terminates timed-out processes', async () => {
    await expect(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 })).rejects.toThrow('timed out');
  });
  it('bounds captured output', { timeout: 15_000 }, async () => {
    await expect(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], { timeoutMs: 10_000 })).rejects.toThrow('output exceeded');
  });
  it('rejects cancellation before spawning', async () => {
    await expect(runProcess(process.execPath, ['--version'], { timeoutMs: 10_000, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
  });
});
