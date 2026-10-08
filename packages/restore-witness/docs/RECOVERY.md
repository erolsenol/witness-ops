# Recovery guide

This alpha performs logical database recovery. It does not provide PITR,
cluster-wide recovery, roles, provider settings, or automatic production restore.

## Prepare before an incident

1. Keep backups on protected storage. Configure age encryption when needed; legacy/plain local backups remain supported.
2. Keep configuration and connection-secret references recoverable separately.
3. Install matching PostgreSQL client tools and pre-pull `postgres:<major>`.
4. Run a restore drill and configure meaningful minimum-row assertions.
5. Record extensions, roles, ownership/ACL expectations, and application settings
   that the logical restore does not recreate.

## Test a backup

Run `restore-witness verify <backup-id> --config PATH`. Check the exit status and
each check in the JSON report. A passed report is evidence for that artifact,
image, and configured assertions at that time. It does not prove application
startup or recreate a complete production cluster.

## Restore into a recovery database

1. Create a dedicated empty database of the same major version.
2. Confirm its effective host/database identity and access permissions.
3. Configure a named development/test restore target through an env reference.
4. Run `restore-witness restore <backup-id> --target recovery`.
5. Check schema, data, constraints, sequence values, permissions, and application
   behavior before any separately managed cutover.

Do not restore untrusted dumps. PostgreSQL archives can contain executable code.
The tool never runs `--clean` and refuses nonempty targets. A failed restore
transaction does not count as a successful recovery.

## Interrupted jobs

Normal cancellation removes transient output and the verification container.
Forced host/process termination can leave resources. Inspect lock owner metadata
and process/container state before removing anything. Restrict cleanup to the
specific job UUID and its exact resource names.

- `.locks/<project>.lock/owner.json`: local lock owner PID and start time.
- `.<backup-uuid>.partial`: unpublished staging directory.
- `restore-witness-<uuid>`: verification container with label
  `org.restore-witness.sandbox=true`; remove its anonymous volumes with the container.

Do not remove unrelated containers, volumes, locks, or backups. After resolving
the interruption, run a fresh verification. Automated stale-lock removal is not implemented.

## Recover from S3 with no local backup

Prepare a clean configuration with the project ID, its `encryption.identityFileEnv`,
S3 bucket/prefix/region/endpoint, and explicit credential references. Recover the
matching private identity file from its separately protected copy; use permissions
0600 or stricter. Keep old identities while any retained backups still need them.

Run `verify <backup-id> --remote --project <project>` first. This downloads the
committed manifest and ciphertext, checks size/SHA-256, authenticates/decrypts with
age, restores into the isolated sandbox, runs assertions, and removes temporary
files. For another explicitly configured empty target, use
`restore <backup-id> --remote --project <project> --target <target>`.

The host needs enough scratch disk for ciphertext and plaintext simultaneously,
matching native tools, and the pre-pulled verification image. Restore-only recovery
does not require Docker; verification does. There is no original local catalog
requirement. Lost recovery identities cannot be recreated from public recipients.

Normal failures remove `.remote-*` and `.decrypt-*` directories. Forced process or
host termination can leave them; inspect their exact owner/job before cleanup.
Provider lifecycle rules should abort old incomplete multipart uploads. A fully
uploaded ciphertext without a manifest is not committed; retrying `push` checks
and reuses it. RestoreWitness does not automatically delete remote orphan objects.

## Interrupted scheduled work and retention

`jobs <project>` lists durable job records. Before resuming a timer, inspect the
scheduler lock (`.locks/schedule-<sha256-of-project-first-32-hex>.lock`), project
lock, owner PID/start time, temporary artifacts, and sandbox containers. Only
remove an exact stale lock after proving its owner is no longer active. Then run
`tick <project>` to record the interruption and `recover-job <job-id>` to abandon
the uncertain slot. It does not rerun the slot or remove stale locks. A backup
committed just before a job-state write may exist in the catalog without its ID
in that interrupted job; inspect and verify it manually.

Retention is local only and must be explicitly applied after a dry run. A normal
failure before validation completes removes nothing. Once deletion starts, some
candidate directories may already be gone. `.pruned-<backup-id>-<uuid>` means a
candidate was removed from the catalog but cleanup did not finish. Inspect its
manifest and history before exact-path cleanup; retained backups are never moved
there. Cancellation/crashes do not roll back already completed deletions. Remote
copies are unaffected, and the next dry run recomputes from the current catalog.
