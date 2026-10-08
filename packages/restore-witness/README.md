# RestoreWitness

**Back up your databases. Prove you can restore them.**

A self-hosted TypeScript CLI for PostgreSQL logical backups, local storage,
isolated restore verification, and recovery reports.

[![CI](https://github.com/erolsenol/restore-witness/actions/workflows/ci.yml/badge.svg)](https://github.com/erolsenol/restore-witness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Status

`0.5.0-alpha.5` is an early alpha. It supports local PostgreSQL custom-format
backups, optional age encryption, S3-compatible upload/download, remote Docker
restore drills, table row assertions, and restore into explicitly configured
empty development/test targets. Daily scheduled jobs, durable history/retries,
local daily/weekly/monthly retention, recovery health monitoring, and opt-in
webhook alerts are also available. Legacy v1 plaintext manifests remain readable.

Remote retention deletion is implemented with an explicit preview/apply flow,
verification receipts, conditional locking and conditional object deletion. A web
panel is not implemented. This release is not a complete production disaster
recovery system. Encryption is opt-in for local backups and mandatory for S3 uploads.
Plaintext exists temporarily during dump/decryption; protect the working disk.

## Requirements

- Node.js 24 or newer, macOS or Linux.
- PostgreSQL 16, 17, or 18; matching-major `pg_dump`, `pg_restore`, and `psql` tools.
- A direct PostgreSQL connection URL in an environment variable.
- Docker for verification, with `postgres:<major>` explicitly pulled beforehand.
- The `age` 1.x CLI for encrypted backups and recovery.

Use direct connections for backup tools. Client/server major versions must match
in this alpha. Standard PostgreSQL images do not include every third-party
extension; an unsupported extension causes verification to fail.

## Install from npm

```sh
npm install --global @erol.senol/restore-witness@alpha
restore-witness --version
```

## Offline install from a GitHub release

Download the `.tgz` package from [Releases](https://github.com/erolsenol/restore-witness/releases), then:

```sh
npm install --global ./erol.senol-restore-witness-0.5.0-alpha.5.tgz
restore-witness --help
```

The `.tgz` release asset installs locally with npm without registry access. The
latest container archive is published separately; check its release notes for
its version and source revision.

## Container installation

Linux AMD64 and ARM64 Docker image archives are available in the GitHub release.
They bundle Node.js, age, PostgreSQL 16/17/18 clients and Docker CLI. Use
`docker load`, select `RW_POSTGRES_MAJOR`, and mount a private persistent working
directory. The image defaults to a non-root user. Verification additionally needs
explicit Docker daemon access and a pre-pulled PostgreSQL sandbox image.
See [container installation, limits and test evidence](docs/CONTAINER.md).

## Quick start

```sh
restore-witness init
# Edit restore-witness.json: configure projects and environment variable names.
# Set EXAMPLE_DATABASE_URL through your shell or secret manager.
docker pull postgres:16
restore-witness doctor example
restore-witness backup example
restore-witness list example
restore-witness verify <backup-id>
restore-witness status example
```

`init` does not overwrite an existing file. By default, configuration is read
from `restore-witness.json`; use `--config PATH` for another file. Relative paths
are resolved against the configuration file's directory.

See [example configuration](examples/restore-witness.json). On macOS with
Homebrew tools outside PATH, set `postgresBinDirectory` to the appropriate bin
directory, such as `/opt/homebrew/opt/postgresql@16/bin`.

The tool reads connection variables from the current process; it does **not** load
`.env` files. URLs require an explicit username, host, and database. Supported
query parameters are `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, and
`channel_binding`; unknown and duplicate parameters are rejected.

## Encryption and S3 storage

Install [age](https://github.com/FiloSottile/age) (`brew install age` on macOS or
`apt install age` on Ubuntu). Create a recovery identity using `age-keygen -o
/path/to/private/identity.txt`, protect its permissions with `chmod 600`, and
record its public recipient using `age-keygen -y /path/to/private/identity.txt`.
Keep a protected recovery copy of the identity outside the backup store. Losing
all matching identities makes encrypted backups unrecoverable.

Configure the project's `encryption.recipient` with that public recipient and
`encryption.identityFileEnv` with the name of a variable containing the private
identity **file path**, never the private key itself. Only native X25519 `age1`
recipients are supported. A recovery file may contain old and new identities for
rotation; old backups retain their original recipient. Use `ageBinDirectory`
when the tools are outside PATH.

See [S3 configuration example](examples/restore-witness.s3.json); replace its
public-recipient placeholder, bucket, endpoint, and secret-reference names.
Supply S3 credentials through the referenced environment variables. There is no
ambient credential/profile fallback. Ambient AWS endpoint overrides are ignored.
`sessionTokenEnv` optionally references a temporary credential session token.
Custom endpoints require HTTPS; loopback-only HTTP is available through the
explicit `allowInsecureLocalEndpoint` flag for local tests.

The bucket must already exist. Allow object read/write, metadata checks,
conditional writes, multipart upload/abort, and permission to distinguish missing
objects in the configured prefix. RestoreWitness does not create buckets or
change provider lifecycle rules in normal operations.

```sh
restore-witness backup example --config restore-witness.s3.json
restore-witness push <backup-id> --config restore-witness.s3.json
restore-witness verify <backup-id> --remote --project example --config restore-witness.s3.json
restore-witness pull <backup-id> --project example --config restore-witness.s3.json
restore-witness restore <backup-id> --remote --project example --target recovery --config restore-witness.s3.json
```

`push` uploads only encrypted v2 artifacts. It streams one 8 MiB multipart chunk
at a time, verifies bytes, checks the stored artifact, and publishes the manifest
last through a conditional write. Existing committed backups are not overwritten;
repeat pushes validate remote bytes. Content-addressed object keys isolate
concurrent different-content uploads. A completed artifact left by a failed
manifest write can be checked and reused on retry. Interrupted multipart uploads
are aborted on normal errors; abrupt process/host termination may leave orphan
parts, so configure a provider lifecycle rule for incomplete multipart uploads.

`pull` verifies ciphertext checksum/size before committing a local catalog entry
and refuses to replace an existing local ID. `--remote` always downloads from S3
into a temporary private working directory, even if a local copy exists. It
needs configuration, credentials, recovery identity, tools, and enough scratch
disk, but no original local backup or catalog. Temporary downloaded/decrypted
files are removed after normal completion or failure. Remote verification reports
are saved under `remote-reports/<project>/<backup-id>.json`; `status` currently
summarizes only the local catalog. Failed downloads return an operational error
before a verification report can be created.

S3 manifests contain project/environment identifiers, timestamps, assertion
names, and plaintext/ciphertext digests. They are not encrypted or signed.
Encryption authenticates ciphertext, not the separately stored manifest; only
use trusted buckets, credentials, and metadata. AWS S3/R2-specific live-account
acceptance is not implied by compatibility tests against RustFS.

## MVP recovery operations

- `list <project> --remote` discovers committed encrypted S3 backups without a local catalog.
- `prune <project> --remote` previews an explicit remote retention policy; add `--apply` only after reviewing it.
- `drill <project>` backs up the selected source read-only, restores only in a disposable sandbox and saves measured recovery timings. Add `--remote` to recover from S3.
- `maximumStorageBytes` limits committed local artifact bytes; backup output and downloads respect the remaining budget.
- Monitoring checks `maximumVerifiedBackupAgeSeconds` separately from the time of verification.

See [MVP operations and pilot evidence](docs/MVP.md).

## Restore verification

`verify` validates checksum and size before starting a disposable PostgreSQL
container. The container has no network access or published ports. Defaults are
512 MiB memory, one CPU, and a 256-process limit; swap is disabled. Configure
`sandboxResources` for larger recovery drills. Docker settings are inspected
before the database starts. Reports record the immutable image ID and the
validated resource profile. See [sandbox resources](docs/SANDBOX.md).
Images are never pulled implicitly during recovery.

The archive restores in a single transaction. The tool queries the restored
catalog and runs table assertions captured in the backup manifest. Each assertion
checks a minimum row count. Empty assertion lists validate restore/catalog access
only; they do not prove application behavior. There is no comparison with the
changing live source database, no physical database integrity scan, and no
application startup smoke test in this alpha.

A verification report is saved beside the backup. Failed assertions, corrupted
artifacts, missing extensions, timeouts, and cleanup failures never produce a
passing report. The temporary container and its anonymous volumes are removed.
Restore success and backup success remain separate from verification success.

## Scheduled operations and local retention

See [scheduled configuration](examples/restore-witness.scheduled.json). Each
project can have a daily `schedule` with an explicit `timeZone`, `backupAt`
(`HH:mm`), optional `verifyAt`, and optional `upload`. Upload requires encryption
and configured S3 storage. Verification restores the latest local backup; it is
independent from backup success. For remote storage drills, continue using the
explicit `verify --remote` command.

```sh
restore-witness tick example --config /absolute/path/restore-witness.json
restore-witness jobs example --config /absolute/path/restore-witness.json
restore-witness prune example --config /absolute/path/restore-witness.json
# Review the freshly computed local plan before explicitly applying it:
restore-witness prune example --apply --config /absolute/path/restore-witness.json
```

Call `tick` about once a minute using your own cron, systemd timer, or macOS
launchd job. There is no resident daemon and this tool does not install a timer.
Use absolute executable/config paths and provide credentials to that timer's
process through your secret manager; interactive shell variables are not assumed
to exist in scheduled sessions. Configure timeouts and pre-pull verification
images before enabling the timer. Each `tick` runs one project's work serially;
external timers must avoid running several large projects at once.

A daily slot becomes due when the local clock reaches the configured time. A
missed time runs on the next tick within that calendar date; downtime across
previous dates is not replayed. A skipped DST hour catches up later that day;
a repeated hour uses the same date/job ID and does not run twice. Backup runs
before verification when both are due. Changing the timezone within an existing
slot is rejected. No automatic retention runs inside `tick`.

Jobs persist under `jobs/`. Failed jobs retry on later ticks in the same calendar
date, up to `maxAttempts` (default 3), after `retryDelaySeconds` (default 300).
Successful backup IDs are saved before upload so upload retry reuses that backup.
A hard stop leaves a running record; the next tick marks it interrupted and
blocks subsequent slots. Inspect effects and lock ownership, then use
`recover-job <job-id>` to acknowledge and abandon the uncertain slot, without
replaying it. Recovery does not remove locks.

Job history is retained until explicitly compacted. Preview terminal records
whose scheduled slot is before a date, then apply only after reviewing the IDs:

```sh
restore-witness compact-jobs example --before 2026-01-01
restore-witness compact-jobs example --before 2026-01-01 --apply
```

The cutoff is exclusive. Running, interrupted, and retry-pending records are
always preserved. Compaction removes job JSON records only; it does not delete
backups or verification reports. Keep exported history if an audit trail is
required. If interrupted after deletion starts, some old records may already be
removed; rerun the preview to see the remaining candidates.

`retention` selects the newest backup in each of the most recent available
`daily`, Monday-based `weekly`, and `monthly` calendar buckets in its `timeZone`
(default UTC). Counts default to 7/4/12 and combine as a union. Empty buckets are
not fabricated. The newest backup and newest locally verified intact recovery
point are always kept, even with all three counts set to zero. Backups referenced
by running/interrupted jobs or eligible same-day retries are also protected.

`prune` defaults to JSON dry-run output with kept/removed IDs, reasons, bytes,
and a blocking reason. `--apply` recomputes the plan under a project lock and
validates all selected project artifacts before deleting any. Deletion is blocked
when there is no intact locally verified recovery point for a nonempty deletion
plan, mismatched project environments, malformed metadata, or corrupt artifacts.
Only local UUID backup directories are deleted; S3 copies and job history stay.
Deletion is irreversible. It is incremental, not a multi-directory transaction:
interruption may leave completed deletions and an ignored `.pruned-*` directory.
See the recovery guide before cleaning up interrupted work.

## Recovery health and notifications

```sh
restore-witness monitor example --config /absolute/path/restore-witness.json
restore-witness monitor example --notify --config /absolute/path/restore-witness.json
```

`monitor` checks the local catalog, artifact integrity, backup/verification age,
scheduled job outcomes, and available disk. Defaults are one day for backup age
and seven days for verification age. It does not contact the source database or
perform a new restore. `--notify` explicitly enables a generic JSON webhook for
that invocation; other commands do not send notifications.

Use [monitored configuration](examples/restore-witness.monitored.json), provide
URL/token environment references to your external timer, and see the
[receiver contract and recovery guide](docs/MONITORING.md). Unchanged acknowledged
conditions stay silent; changed conditions and recovery send a new event. Failed
deliveries retain a stable event ID/body and retry on later invocations after
backoff. Receivers should deduplicate IDs because HTTP acceptance and the local
receipt cannot be committed atomically. No production receiver is enabled by
installation, and native email/chat-provider adapters are not implemented.

## Restore to another database

Create an empty development/test database and configure its environment-variable
reference under `restoreTargets`. Then:

```sh
restore-witness restore <backup-id> --target recovery
```

The command refuses known source matches and nonempty targets. It never uses
`--clean`, drops a database, or overwrites existing objects. Targets use the same
major version as the backup. Ownership and ACLs are not replayed.

The environment label is user configuration, not server-side proof of a database's
purpose. Verify your target connection before running restore. Aliases of a source
endpoint may have different fingerprints; the empty-target guard still applies.
Do not run concurrent external DDL during a restore.

## Results and exit codes

Commands return JSON. Errors omit database stderr and connection values.

- `0`: operation or verification passed.
- `1`: operation, prerequisite, or verification failed.
- `2`: invalid CLI usage.

`doctor` returns a failure when the verification environment is unavailable.
`status` shows backup age, the latest verification report, and the newest backup
with a currently passing report. Reports are observations at a point in time;
previous success does not guarantee that an artifact has not changed later.

## Storage and recovery limits

Plaintext or encrypted artifacts and manifests are written under a private staging directory and become
visible together through a final rename. Files use mode `0600`; new directories
use `0700`. Storage must be a trusted local filesystem. Existing parent permissions
are not rewritten. SHA-256 detects accidental changes; manifests are not signed.

A project lock prevents overlapping jobs in the same storage directory. It is not
a distributed lock. After a forced process kill, inspect `.locks/<project>.lock`
and its owner metadata before removing a stale lock. Interrupted staging
directories are ignored by the catalog; clean them only after checking active jobs.

The `minimumFreeBytes` backup admission check defaults to 128 MiB and can be
raised. It is a free-space floor, not an estimate of your dump size or a quota.
It does not continuously monitor disk consumption during a dump.
Verification also consumes Docker disk space. Configure job timeouts and size your
host for the database. Metadata and captured tool output are limited to 1 MiB.

Logical backups cover one database, not cluster-global roles/tablespaces, WAL,
PITR, host configuration, or every provider setting. Restore only trusted dumps:
PostgreSQL restores can execute code embedded by source superusers.

## Development

```sh
npm ci
npm run check
# Requires Docker, a pre-pulled postgres:16 image, and matching client tools:
RW_TEST_MAJOR=16 npm run test:integration
```

Set `RW_POSTGRES_BIN_DIRECTORY` if the test tools are outside PATH. Integration
tests create and remove their own database containers; they never use your
application DATABASE_URL. Normal unit runs skip the explicit integration suite.
CI runs actual recovery tests against PostgreSQL 16, 17, and 18, including encrypted
S3 recovery and multipart transfers against a disposable pinned RustFS service.
Real age unit tests require `RW_AGE_BIN_DIRECTORY`; local S3 integration tests
also need an explicit disposable `RW_TEST_S3_ENDPOINT` and test credentials.
For macOS environments without Docker-to-host port forwarding, set
`RW_TEST_NATIVE=1` and `RW_POSTGRES_BIN_DIRECTORY`; the test source uses a
temporary local cluster while verification still uses isolated Docker.

See [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md),
[recovery guide](docs/RECOVERY.md), [contributing](CONTRIBUTING.md), and
[security policy](SECURITY.md).

## License

[MIT](LICENSE), copyright Erol Senol.
