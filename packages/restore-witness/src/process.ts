import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WitnessError } from './errors.js';

export interface ProcessOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly inputFile?: string;
  readonly outputFile?: { readonly path: string; readonly maximumBytes: number };
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

// Do not inherit ambient PG*, NODE_OPTIONS, or application secrets into tools.
export function toolEnvironment(): Record<string, string> {
  const result: Record<string, string> = { LC_ALL: 'C', LANG: 'C' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export async function runProcess(binary: string, args: readonly string[], options: ProcessOptions): Promise<string> {
  if (options.signal?.aborted) throw new WitnessError('Operation cancelled.');
  if (options.outputFile && (!Number.isSafeInteger(options.outputFile.maximumBytes) || options.outputFile.maximumBytes < 1)) throw new WitnessError('Invalid output file capacity.');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, env: { ...toolEnvironment(), ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let failure: string | undefined;
    let outputBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string): void => {
      failure ??= message;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const cancel = (): void => stop('Operation cancelled.');
    const timer = setTimeout(() => stop('Tool execution timed out.'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const clean = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
    };
    let outputFinished: Promise<void> = Promise.resolve();
    if (options.outputFile) {
      const capacity = options.outputFile.maximumBytes;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        outputBytes += chunk.length;
        if (outputBytes > capacity) {
          stop('Output file exceeded the available storage budget.');
          callback(new WitnessError('Output file exceeded the available storage budget.'));
        } else callback(null, chunk);
      } });
      outputFinished = pipeline(child.stdout, bounded, createWriteStream(options.outputFile.path, { flags: 'wx', mode: 0o600 }))
        .catch(() => { stop('Cannot write tool output to protected storage.'); });
    } else child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) stop('Tool output exceeded the 1 MiB limit.');
      else output += chunk.toString('utf8');
    });
    // Database errors may contain passwords or row contents; never forward them.
    child.stderr.resume();
    child.once('error', () => {
      clean();
      reject(new WitnessError('Cannot start required tool. Check installation and executable paths.'));
    });
    child.once('close', (code) => {
      void outputFinished.then(() => {
        clean();
        if (failure) reject(new WitnessError(failure));
        else if (code !== 0) reject(new WitnessError('Tool failed. Check connectivity, permissions, versions, and required extensions.'));
        else resolve(output.trim());
      });
    });
    if (options.inputFile) {
      void pipeline(createReadStream(options.inputFile), child.stdin).catch(() => stop('Cannot stream backup into restore tool.'));
    } else child.stdin.end();
  });
}
