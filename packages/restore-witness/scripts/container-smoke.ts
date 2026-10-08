import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.env.RW_CONTAINER_IMAGE;
const version = process.env.RW_CONTAINER_VERSION;
const revision = process.env.RW_CONTAINER_REVISION;
const architecture = process.env.RW_CONTAINER_ARCH;
if (!image || !version || !revision || !architecture) throw new Error('Explicit container image/version/revision are required.');
const root = await mkdtemp(join(tmpdir(), 'rw-container-'));
const network = `rw-test-${randomUUID()}`;
const { uid, gid } = userInfo();
const dockerGroup = execFileSync('stat', ['-c', '%g', '/var/run/docker.sock'], { encoding: 'utf8' }).trim();
const names: string[] = [];
let networkCreated = false;
function docker(args: readonly string[], env: Readonly<Record<string, string>> = {}, expected = 0): string {
  const result = spawnSync('docker', [...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== expected) throw new Error(`Container smoke failed at ${args[0]} (expected ${expected}, actual ${result.status}).`);
  return result.stdout.trim();
}
function run(args: readonly string[], major = 18, env: Readonly<Record<string, string>> = {}, expected = 0, socket = false): string {
  return docker(['run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--network', network,
    '--user', `${uid}:${gid}`, '--mount', `type=bind,source=${root},target=/work`, '-e', `RW_POSTGRES_MAJOR=${major}`,
    ...Object.keys(env).flatMap((key) => ['-e', key]),
    ...(socket ? ['--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', '--group-add', dockerGroup] : []),
    image ?? '', ...args], env, expected);
}
try {
  if (docker(['image', 'inspect', image, '--format', '{{.Architecture}}']) !== architecture) throw new Error('Image architecture does not match the native test runner.');
  const configuredUser = docker(['image', 'inspect', image, '--format', '{{.Config.User}}']);
  if (configuredUser !== '10001:10001') throw new Error('Container must default to a non-root user.');
  const label = (name: string): string => docker(['image', 'inspect', image, '--format', `{{index .Config.Labels "${name}"}}`]);
  if (label('org.opencontainers.image.version') !== version || label('org.opencontainers.image.revision') !== revision) throw new Error('Container labels do not match exact build identity.');
  docker(['network', 'create', network]); networkCreated = true;
  if (run(['--version']) !== version) throw new Error('CLI version mismatch.');
  run(['--version'], 18, { RW_POSTGRES_MAJOR: 'invalid' }, 2);
  const binaries = docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', 'node --version; age --version; docker --version; for v in 16 17 18; do /usr/lib/postgresql/$v/bin/pg_dump --version; done']);
  if (!binaries.includes('v24.') || ![16, 17, 18].every((major) => binaries.includes(`PostgreSQL) ${major}.`))) throw new Error('Required native tools are missing.');
  for (const major of [16, 17, 18]) {
    const name = `rw-source-${randomUUID()}`; names.push(name);
    const password = randomUUID();
    docker(['pull', `postgres:${major}`]);
    docker(['create', '--name', name, '--label', 'org.restore-witness.test=true', '--network', network,
      '--memory', '512m', '--cpus', '1', '-e', 'POSTGRES_DB=source', '-e', `POSTGRES_PASSWORD=${password}`, `postgres:${major}`]);
    docker(['start', name]);
    let ready = false;
    for (let index = 0; index < 60; index++) {
      const result = spawnSync('docker', ['exec', name, 'sh', '-c', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'], { timeout: 10_000, stdio: 'ignore' });
      if (result.status === 0) { ready = true; break; }
      await delay(1000);
    }
    if (!ready) throw new Error('Disposable source did not become ready.');
    docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'source', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE TABLE accounts(id integer PRIMARY KEY); INSERT INTO accounts VALUES (1),(2)"]);
    const identity = `identity-${major}.txt`;
    docker(['run', '--rm', '--user', `${uid}:${gid}`, '--mount', `type=bind,source=${root},target=/work`, '--entrypoint', 'age-keygen', image, '-o', `/work/${identity}`]);
    await chmod(join(root, identity), 0o600);
    const recipient = docker(['run', '--rm', '--user', `${uid}:${gid}`, '--mount', `type=bind,source=${root},target=/work`, '--entrypoint', 'age-keygen', image, '-y', `/work/${identity}`]);
    const sandboxResources = { memoryMiB: 640, cpus: 0.5, pidsLimit: 128 };
    const config = { version: 1, storageDirectory: `./backups-${major}`, sandboxResources, projects: { example: { environment: 'test', connectionEnv: 'RW_CONTAINER_SOURCE',
      assertions: [{ table: 'accounts', minimumRows: 2 }], encryption: { recipient, identityFileEnv: 'RW_CONTAINER_IDENTITY' } } } };
    const file = `config-${major}.json`; await writeFile(join(root, file), JSON.stringify(config), { mode: 0o600 });
    const env = { RW_CONTAINER_SOURCE: `postgresql://postgres:${password}@${name}:5432/source`, RW_CONTAINER_IDENTITY: `/work/${identity}` };
    const saved: unknown = JSON.parse(run(['backup', 'example', '--config', file], major, env));
    if (typeof saved !== 'object' || saved === null || !('id' in saved) || typeof saved.id !== 'string' || !('version' in saved) || saved.version !== 2) throw new Error('Encrypted backup contract mismatch.');
    const report: unknown = JSON.parse(run(['verify', saved.id, '--config', file], major, env, 0, true));
    if (typeof report !== 'object' || report === null || !('passed' in report) || report.passed !== true) throw new Error('Container sandbox verification failed.');
    if (!('sandboxResources' in report) || JSON.stringify(report.sandboxResources) !== JSON.stringify(sandboxResources)) throw new Error('Sandbox resource report mismatch.');
    const monitored: unknown = JSON.parse(run(['monitor', 'example', '--config', file], major));
    if (typeof monitored !== 'object' || monitored === null || !('healthy' in monitored) || monitored.healthy !== true) throw new Error('Container monitor contract failed.');
    const archive = join(root, `backups-${major}`, saved.id, 'backup.dump.age');
    const ciphertext = await readFile(archive); await writeFile(archive, ciphertext.subarray(0, ciphertext.length - 1));
    run(['monitor', 'example', '--config', file], major, {}, 1);
    docker(['rm', '--force', '--volumes', name]); names.splice(names.indexOf(name), 1);
    console.log(`Container PostgreSQL ${major}: encrypted backup, sandbox verification, monitor and corruption detection passed.`);
  }
} finally {
  for (const name of names) docker(['rm', '--force', '--volumes', name]);
  if (networkCreated) docker(['network', 'rm', network]);
  await rm(root, { recursive: true, force: true });
}
