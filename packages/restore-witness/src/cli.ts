#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCommand } from './commands.js';

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

if (
  typeof manifest !== 'object' || manifest === null ||
  !('version' in manifest) || typeof manifest.version !== 'string'
) {
  throw new Error('Package manifest must contain a string version.');
}

process.umask(0o077);
const controller = new AbortController();
const cancel = (): void => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const result = await runCommand(process.argv.slice(2), manifest.version, controller.signal);
process.removeListener('SIGINT', cancel);
process.removeListener('SIGTERM', cancel);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
