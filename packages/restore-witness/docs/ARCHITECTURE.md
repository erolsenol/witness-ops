# Architecture

RestoreWitness is a single TypeScript CLI package. Keep concrete modules until
additional adapters justify shared interfaces.

## Implemented modules

- `commands`: strict argument parsing, config selection, JSON results, deadlines.
- `config`: strict runtime validation and paths relative to the config file.
- `postgres`: secret-reference resolution, connection env, native tool versions,
  query formatting, and empty-target checks.
- `process`: shell-free subprocess execution, bounded output, cancellation,
  timeouts, streaming stdin, and sanitized failures.
- `storage`: versioned manifests/reports, streaming hashes, atomic writes, and locks.
- `operations`: backup, prerequisites, catalog, status, verification, and restore.
- `encryption`: native age encryption, private identity references, and plaintext cleanup.
- `s3`: explicit AWS SDK credentials/endpoints, bounded transfers, conditional commit
  markers, temporary downloads, and remote recovery contexts.
- `monitoring`: read-only local observations, age thresholds, artifact integrity and job/disk health.
- `notifications`: explicit webhook delivery, durable pending event IDs, backoff and condition suppression.
- `calendar`: explicit timezone calendar dates and Monday-week buckets.
- `scheduler`: daily slots, durable state transitions, bounded retries and interruption acknowledgment.
- `retention`: pure calendar policy evaluation and guarded local deletion under a project lock.
- `sandbox`: immutable image selection, resource-limited isolated Docker restore,
  readiness checks, and cleanup.

## Backup lifecycle

1. Validate project and resolve its connection from an environment reference.
2. Acquire the project lock and check source/client major versions and disk space.
3. Create a private staging directory and dump with native `pg_dump`.
4. Hash and sync the artifact; write and sync its manifest.
5. Rename the staging directory to its UUID, making it visible to the catalog.
6. Release the lock. Failure removes staging output; abrupt host/process termination
   can leave ignored staging data and a stale lock.

Atomic rename controls catalog visibility; this alpha does not claim complete
power-loss durability on every filesystem or directory fsync guarantees.

## Verification lifecycle

Validate manifest and artifact before restoring. Use a pre-pulled official
matching-major image, resolved to its immutable local image ID. Restore without
ownership/ACL replay in a single transaction and run manifest-defined assertions.
Cleanup must succeed before the report can pass. Persist the latest report beside
the artifact. Every result names its checks; no checksum-only result counts as
successful recovery verification.

## Restore boundary

Only named development/test targets can be configured. Refuse known source
fingerprints and nonempty databases. Target validation is not an authorization
system: operator-supplied environment labels and endpoint aliases are not proof
of a server's identity. No destructive clean/drop workflow exists in this alpha.
External DDL races are not coordinated; operators must use a dedicated target.

## Resource and secrecy boundaries

Captured stdout and metadata have a 1 MiB limit. Stderr from database processes
is discarded because it can contain credentials or row data. Only selected
runtime/Docker variables and explicit PostgreSQL connection variables are passed
to subprocesses. Connection URLs never appear in tool arguments, manifests, or
reports. Database table/schema names and configured project IDs are metadata.

CLI signals cancel active tools; SIGTERM escalates to SIGKILL after one second.
Sandbox cleanup uses a separate bounded deadline after cancellation. Locks apply
only to users sharing the same local storage directory. Storage/manifests/config
are trusted local inputs; no signed-manifest or multi-user isolation guarantee
exists in this release.

## Encrypted and remote artifacts

V1 manifests identify a plaintext `backup.dump`. V2 manifests identify an age
X25519 `backup.dump.age`, its ciphertext SHA-256/size, original plaintext
digest/size, and public recipient. Private identity material is never persisted
in manifests. A private identity file path is resolved only for recovery.

Encryption/decryption uses the maintained age CLI. Plaintext is temporarily
present in private working directories and unlinked after normal completion or
failure; deletion is not secure erasure or protection against disk snapshots.
Forced termination can leave temporary plaintext. Use protected/encrypted disks.

S3 object layout is `<prefix>/<project>/<backup-id>/<ciphertext-sha256>.dump.age`
and a final `manifest.json` commit marker. Conditional writes and content-addressed
names prevent different-content concurrent uploads from overwriting an already
committed artifact. Full-byte checks validate existing objects before retrying.
Multipart uploads use one 8 MiB part at a time. Normal known-ID multipart failures
receive an explicit bounded abort; provider lifecycle rules remain necessary for
forced termination or interrupted upload creation with an unknown upload ID.

Remote recovery reuses the same verification/restore services in a temporary
local catalog. Project and restore target locks still use the original shared
local storage where needed. No original local artifact or manifest is required.
Downloaded artifacts are checked before decryption. Normal cleanup removes the
temporary remote catalog; remote verification reports persist separately.

S3 credentials must be explicit environment references. Ambient credential chains
and endpoint overrides are disabled. Metadata/config/buckets remain trusted
operator inputs; age authenticity does not sign the separate manifest. The tool
makes no IAM policy, bucket creation, or production provider changes.

## Scheduled jobs and retention

External timers invoke `tick <project>`; no daemon, cron installation, or provider
mutation is hidden in configuration. A hashed scheduler lock serializes durable
job state while existing project locks guard backup/upload/verification effects.
Each job has a project/kind/local-date identity. Intent is persisted before an
effect; successful backup IDs are persisted before upload. Failed effects use
bounded backoff within the same date. Hard stops require acknowledgment rather
than guessing whether an effect completed. Completed slots are not replayed.

Local retention evaluates a union of calendar buckets, newest backup and newest
intact verified recovery point. Apply recomputes under the project lock, validates
all project artifacts, then moves candidates to unique ignored trash names and
removes them one at a time. This is not a transactional multi-backup delete or
secure erasure. Remote objects and durable job records are outside its scope.

## Monitoring and delivery

Monitoring reads local atomic metadata and streams artifact hashes without live
source access. It is a best-effort snapshot; catalog mutation can yield a transient
unavailable observation. Recovery verification remains a separate operation.
Webhook delivery uses a distinct hashed notification lock. Condition fingerprints
exclude changing ages/disk figures, and pending event IDs/bodies are persisted
before the request. Only an HTTP 2xx acknowledges delivery. Retries keep their ID;
changed states supersede pending obsolete observations. Receipt writes cannot be
atomic with an external receiver, so receiver-side deduplication is required.
Endpoints/tokens come from env references, redirects are refused, and generic
payloads exclude database/credential/error contents. See MONITORING.md for the
complete contract, timer integration, and failure boundaries.
