import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exampleConfig, loadConfig, selectProject } from './config.js';
import { safeMessage, WitnessError } from './errors.js';
import { backup, doctor, restore, status, verify } from './operations.js';
import { atomicJson, listBackups, loadManifest } from './storage.js';
import { drill } from './drill.js';
import { monitor } from './monitoring.js';
import { monitorAndNotify } from './notifications.js';
import { compactJobs, listJobs, recoverJob, tick } from './scheduler.js';
import { prune } from './retention.js';
import { listRemoteBackups, pruneRemote, pullBackup, pushBackup, recordRemoteVerification, withRemoteBackup } from './s3.js';

export interface CommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const help = `RestoreWitness — database backup management and restore verification

Usage: restore-witness <command> [identifier] [options]

Commands:
  init                       Write an example config without overwriting
  doctor <project>           Check PostgreSQL tools, connection, disk, sandbox
  backup <project>           Create a local PostgreSQL custom-format backup
  list <project>             List completed backup manifests
  status <project>           Show latest backup and backup count
  verify <backup-id>         Restore into an isolated Docker sandbox and test
  restore <backup-id>        Restore to an explicit empty development/test target
  push <backup-id>           Upload an encrypted backup to configured S3 storage
  pull <backup-id>           Download a committed S3 backup (--project required)
  monitor <project>         Check local recovery health (--notify for webhook)
  tick <project>            Run due daily jobs and bounded retries
  jobs <project>            Show durable scheduled job history
  compact-jobs <project>    Preview old terminal job history compaction
  recover-job <job-id>      Acknowledge interrupted work without replaying it
  prune <project>           Preview local retention deletions (--apply to delete)
  drill <project>           Measure a read-only source / isolated recovery drill

Options:
  -h, --help     Show this help
  -v, --version  Show the version
  --config PATH  JSON configuration (default: restore-witness.json)
  --target ID    Configured restore target (restore command only)
  --remote       Use S3 for list/prune/drill or as source for verify/restore
  --project ID   Required for pull or --remote
  --notify       Deliver changed monitor state to configured webhook
  --apply        Execute the selected prune or job-history compaction plan
  --before DATE  Job slot cutoff for compact-jobs (YYYY-MM-DD)

Results are JSON. Exit codes: 0 success, 1 operational/check failure, 2 usage error.
Alpha: PostgreSQL 16–18, optional age encryption, local and S3-compatible storage.
Verification requires a pre-pulled Docker postgres:<major> image.
Schedules require an external timer calling tick. Retention defaults to a dry run.
`;

export async function runCommand(
  args: readonly string[],
  version: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0] ?? ''))) {
    return { exitCode: 0, stdout: process.env.WITNESS_OPS_CLI_GROUP === 'db'
      ? help.replace('RestoreWitness', 'WitnessOps').replace('Usage: restore-witness', 'Usage: witness db')
      : help, stderr: '' };
  }

  if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
    return { exitCode: 0, stdout: `${version}\n`, stderr: '' };
  }

  const optionDefinitions = { config: { type: 'string' }, target: { type: 'string' }, project: { type: 'string' }, before: { type: 'string' }, remote: { type: 'boolean' }, apply: { type: 'boolean' }, notify: { type: 'boolean' } } as const;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof optionDefinitions; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, strict: true,
      options: optionDefinitions });
    // Duplicate options are likely mistakes; never silently take the last value.
    for (const option of ['--config', '--target', '--project', '--before', '--remote', '--apply', '--notify']) {
      if (args.filter((arg) => arg === option || arg.startsWith(`${option}=`)).length > 1) throw new Error('Duplicate');
    }
  } catch { return usageError(); }
  const [command, id] = parsed.positionals;
  if (!command || !['init', 'doctor', 'backup', 'list', 'status', 'verify', 'restore', 'push', 'pull', 'tick', 'jobs', 'compact-jobs', 'recover-job', 'prune', 'monitor', 'drill'].includes(command)) return usageError();
  if (parsed.positionals.length !== (command === 'init' ? 1 : 2)) return usageError();
  if ((command === 'restore') !== (parsed.values.target !== undefined)) return usageError();
  if (parsed.values.apply && !['prune', 'compact-jobs'].includes(command)) return usageError();
  if ((command === 'compact-jobs') !== (parsed.values.before !== undefined)) return usageError();
  if (parsed.values.notify && command !== 'monitor') return usageError();
  const remote = parsed.values.remote === true;
  if (remote && !['verify', 'restore', 'list', 'prune', 'drill'].includes(command)) return usageError();
  if ((command === 'pull' || (remote && ['verify', 'restore'].includes(command))) !== (parsed.values.project !== undefined)) return usageError();
  const path = resolve(parsed.values.config ?? 'restore-witness.json');
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (command === 'init') {
      await writeFile(path, `${JSON.stringify(exampleConfig, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return jsonResult({ initialized: true });
    }
    const loaded = await loadConfig(path);
    const timeoutMs = loaded.config.timeoutSeconds * 1000;
    timer = setTimeout(cancel, timeoutMs);
    const options = { timeoutMs, signal: controller.signal };
    if (!id) throw new WitnessError('Missing identifier.');
    switch (command) {
      case 'monitor': {
        if (parsed.values.notify) {
          const result = await monitorAndNotify(loaded, id, controller.signal);
          return jsonResult(result, result.report.healthy && !['failed', 'retry-pending'].includes(result.notification.status) ? 0 : 1);
        }
        const result = await monitor(loaded, id, controller.signal);
        return jsonResult(result, result.healthy ? 0 : 1);
      }
      case 'jobs': return jsonResult(await listJobs(loaded, id));
      case 'compact-jobs': return jsonResult(await compactJobs(loaded, id, parsed.values.before ?? '', parsed.values.apply === true));
      case 'recover-job': return jsonResult(await recoverJob(loaded, id));
      case 'prune': return jsonResult(remote ? await pruneRemote(loaded, id, parsed.values.apply === true, options) : await prune(loaded, id, parsed.values.apply === true, controller.signal));
      case 'drill': {
        const result = await drill(loaded, id, remote, options);
        return jsonResult(result, result.passed ? 0 : 1);
      }
      case 'tick': {
        const result = await tick(loaded, id, options);
        return jsonResult(result, result.healthy ? 0 : 1);
      }
      case 'doctor': {
        const report = await doctor(loaded, id, options);
        return jsonResult(report, report.healthy ? 0 : 1);
      }
      case 'backup': return jsonResult(await backup(loaded, id, options));
      case 'push': return jsonResult(await pushBackup(loaded, id, options));
      case 'pull': return jsonResult(await pullBackup(loaded, parsed.values.project ?? '', id, options));
      case 'list':
        selectProject(loaded.config, id);
        return jsonResult(remote ? await listRemoteBackups(loaded, id, options) : await listBackups(loaded.storageDirectory, id));
      case 'status': return jsonResult(await status(loaded, id));
      case 'verify': {
        const report = remote
          ? await withRemoteBackup(loaded, parsed.values.project ?? '', id, options, async (temporary) => {
            const result = await verify(temporary, id, options);
            await recordRemoteVerification(loaded, await loadManifest(temporary.storageDirectory, id), result, options);
            return result;
          })
          : await verify(loaded, id, options);
        if (remote) {
          const directory = join(loaded.storageDirectory, 'remote-reports', parsed.values.project ?? '');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await atomicJson(join(directory, `${id}.json`), { origin: 's3', report });
        }
        return jsonResult(report, report.passed ? 0 : 1);
      }
      case 'restore': return jsonResult(remote
        ? await withRemoteBackup(loaded, parsed.values.project ?? '', id, options, (temporary) => restore(temporary, id, parsed.values.target ?? '', options, loaded.storageDirectory))
        : await restore(loaded, id, parsed.values.target ?? '', options));
      default: return usageError();
    }
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${safeMessage(error)}\n` };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function usageError(): CommandResult {
  return { exitCode: 2, stdout: '', stderr: process.env.WITNESS_OPS_CLI_GROUP === 'db'
    ? 'Unsupported command or arguments. Run witness db --help.\n'
    : 'Unsupported command or arguments. Run restore-witness --help.\n' };
}

function jsonResult(data: unknown, exitCode: 0 | 1 = 0): CommandResult {
  return { exitCode, stdout: `${JSON.stringify(data, null, 2)}\n`, stderr: '' };
}
