import { describe, expect, it } from 'vitest';
import { configSchema, exampleConfig } from '../src/config.js';
import { connectionFromEnv, quoteIdentifier } from '../src/postgres.js';

describe('configuration boundary', () => {
  it('accepts secret references and provides defaults', () => {
    const config = configSchema.parse(exampleConfig);
    expect(config.projects.example?.assertions).toEqual([]);
    expect(config.sandboxResources).toEqual({ memoryMiB: 512, cpus: 1, pidsLimit: 256 });
  });
  it('accepts bounded resource overrides and partial configuration', () => {
    expect(configSchema.parse({ ...exampleConfig, sandboxResources: { cpus: 0.25 } }).sandboxResources)
      .toEqual({ memoryMiB: 512, cpus: 0.25, pidsLimit: 256 });
    expect(configSchema.safeParse({ ...exampleConfig, sandboxResources: { memoryMiB: 65536, cpus: 32, pidsLimit: 4096 } }).success).toBe(true);
  });
  it.each([
    { memoryMiB: 255 }, { memoryMiB: 65537 }, { memoryMiB: 512.5 }, { memoryMiB: '512m' },
    { cpus: 0 }, { cpus: 32.25 }, { cpus: 0.3 }, { cpus: Infinity },
    { pidsLimit: 31 }, { pidsLimit: 4097 }, { pidsLimit: -1 }, { privileged: true },
  ])('rejects unsupported or unlimited sandbox limits', (sandboxResources) => {
    expect(configSchema.safeParse({ ...exampleConfig, sandboxResources }).success).toBe(false);
  });
  it('rejects insecure nonlocal S3 endpoints and invalid key references', () => {
    const storage = { bucket: 'example-bucket', region: 'us-east-1', accessKeyEnv: 'ACCESS', secretKeyEnv: 'SECRET' };
    for (const endpoint of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?secret=value']) {
      expect(configSchema.safeParse({ ...exampleConfig, s3: { ...storage, endpoint, allowInsecureLocalEndpoint: true } }).success).toBe(false);
    }
    expect(configSchema.safeParse({ ...exampleConfig, s3: { ...storage, endpoint: 'http://127.0.0.1:9000' } }).success).toBe(false);
    expect(configSchema.safeParse({ ...exampleConfig, s3: { ...storage, endpoint: 'http://127.0.0.1:9000', allowInsecureLocalEndpoint: true } }).success).toBe(true);
    expect(configSchema.safeParse({ ...exampleConfig, s3: { ...storage, prefix: '../escape' } }).success).toBe(false);
  });
  it.each([
    { ...exampleConfig, password: 'do-not-store' },
    { ...exampleConfig, projects: {} },
    { ...exampleConfig, projects: { '../escape': exampleConfig.projects.example } },
    { ...exampleConfig, timeoutSeconds: 0 },
    { ...exampleConfig, restoreTargets: { recovery: { environment: 'production', connectionEnv: 'DB' } } },
  ])('rejects invalid or unsafe config', (value) => {
    expect(configSchema.safeParse(value).success).toBe(false);
  });
});

describe('connection handling', () => {
  it('decodes passwords without adding URL to arguments or fingerprint', () => {
    const connection = connectionFromEnv('DB', { DB: 'postgresql://user:p%40ss@localhost:5433/example?sslmode=require' });
    expect(connection.env.PGPASSWORD).toBe('p@ss');
    expect(connection.env.PGSSLMODE).toBe('require');
    expect(connection.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(connectionFromEnv('DB', { DB: 'postgresql://other:different@localhost:5433/example' }).fingerprint).toBe(connection.fingerprint);
  });
  it.each([
    'https://user:secret@localhost/db', 'postgresql://localhost/db',
    'postgresql://user:secret@localhost/', 'postgresql://user:secret@localhost/db?options=-c%20search_path=evil',
    'postgresql://user:secret@localhost/db?sslmode=require&sslmode=disable',
    'postgresql://user:secret@localhost/db#fragment',
    'postgresql://user:secret@localhost/host%3Devil',
    'postgresql://user:secret@localhost:0/db',
  ])('rejects unsafe URLs without revealing secrets', (url) => {
    expect(() => connectionFromEnv('DB', { DB: url })).toThrow('Invalid PostgreSQL URL');
    try { connectionFromEnv('DB', { DB: url }); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });
  it('quotes identifiers instead of interpreting SQL', () => {
    expect(quoteIdentifier('a"; DROP TABLE users;--')).toBe('"a""; DROP TABLE users;--"');
  });
});
