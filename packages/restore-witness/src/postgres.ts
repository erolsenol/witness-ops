import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WitnessError } from './errors.js';
import { runProcess, type ProcessOptions } from './process.js';

export interface Connection {
  readonly env: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}

export function connectionFromEnv(name: string, environment: NodeJS.ProcessEnv = process.env): Connection {
  const raw = environment[name];
  if (!raw) throw new WitnessError(`Required connection environment variable ${name} is missing.`);
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) throw new Error('Incomplete URL');
    if (url.hash) throw new Error('URL fragment');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if ([host, database, user, password].some((value) => /[\0\r\n]/.test(value))) throw new Error('Invalid character');
    // pg_restore --dbname treats '=' and URI strings as connection strings.
    if (database.includes('=') || database.includes('/') || url.port === '0') throw new Error('Ambiguous database or port');
    const env: Record<string, string> = {
      PGHOST: host, PGPORT: url.port || '5432', PGDATABASE: database,
      PGUSER: user, PGPASSWORD: password, PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'restore-witness',
    };
    const allowed = new Map([
      ['sslmode', 'PGSSLMODE'], ['sslrootcert', 'PGSSLROOTCERT'],
      ['sslcert', 'PGSSLCERT'], ['sslkey', 'PGSSLKEY'], ['channel_binding', 'PGCHANNELBINDING'],
    ]);
    for (const [key, value] of url.searchParams) {
      const pgKey = allowed.get(key);
      if (!pgKey || !value || /[\0\r\n]/.test(value) || [...url.searchParams.keys()].filter((item) => item === key).length !== 1) throw new Error('Unsupported parameter');
      env[pgKey] = value;
    }
    // URL parameters never become command arguments or report fields.
    return { env, fingerprint: createHash('sha256').update(JSON.stringify([host.toLowerCase(), env.PGPORT, database])).digest('hex') };
  } catch {
    throw new WitnessError('Invalid PostgreSQL URL. Use an explicit user, host, and database; only documented TLS parameters are supported.');
  }
}

export function pgTool(directory: string | undefined, name: 'pg_dump' | 'pg_restore' | 'psql'): string {
  return directory === undefined ? name : join(directory, name);
}

export function parseToolMajor(output: string): number {
  const match = /\(PostgreSQL\) (\d+)\./.exec(output);
  if (!match?.[1]) throw new WitnessError('Cannot identify PostgreSQL tool version.');
  return Number(match[1]);
}

export function parseInteger(output: string): number {
  if (!/^\d+$/.test(output) || !Number.isSafeInteger(Number(output))) throw new WitnessError('Unexpected PostgreSQL query result.');
  return Number(output);
}

export async function query(directory: string | undefined, connection: Connection, sql: string, options: ProcessOptions): Promise<string> {
  return runProcess(pgTool(directory, 'psql'), ['-X', '--no-password', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--command', sql], { ...options, env: connection.env });
}

export async function checkVersions(directory: string | undefined, connection: Connection, options: ProcessOptions): Promise<number> {
  const server = Math.floor(parseInteger(await query(directory, connection, 'SHOW server_version_num', options)) / 10000);
  if (server < 16 || server > 18) throw new WitnessError('This alpha supports PostgreSQL 16–18 only.');
  for (const name of ['pg_dump', 'pg_restore', 'psql'] as const) {
    const major = parseToolMajor(await runProcess(pgTool(directory, name), ['--version'], options));
    if (major !== server) throw new WitnessError('PostgreSQL client and server major versions must match in this alpha.');
  }
  return server;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export const userTableCountSql = `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
export const targetObjectCountSql = `SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') +
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')) +
  (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%') +
  (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql') +
  (SELECT count(*) FROM pg_largeobject_metadata)`;
