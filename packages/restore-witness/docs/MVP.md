# MVP recovery operations

## Fresh verified data

Monitoring now exposes three independent ages:

- `backupAgeSeconds`: newest completed local backup.
- `verificationAgeSeconds`: last successful check of the selected recovery point.
- `verifiedBackupAgeSeconds`: data age of the newest successfully verified backup.

`maximumVerifiedBackupAgeSeconds` defaults to 86400. A fresh unverified backup
plus a freshly rechecked week-old backup is unhealthy (`verified-backup-stale`).
Rechecking old data cannot make its recovery point fresh. Selection prefers the
newest verified snapshot, not the most recently rechecked report. This changes
monitor behavior for existing configs with stale verified data.

New manifests record `snapshotStartedAt`, the time immediately before invoking
pg_dump; this is a conservative data-age reference, not the exact database LSN or
PITR guarantee. Legacy manifests fall back to completion `createdAt`, which can
underestimate data age for long-running legacy dumps. Hash failures still alert.
Local monitoring does not establish S3 availability or application startup.

## Local storage quota

Optional root `maximumStorageBytes` (minimum 128 MiB) limits the sum of actual
committed local artifact sizes across ALL catalog projects, including projects
absent from current configuration. It is unset by default. `monitor` reports
`storageBytes`, `storage-quota-exhausted` and measurement failures.

Backup/pull writers share a separate durable quota lock. Dump/encryption output
streams into private exclusive files with a byte ceiling; exceeding the remaining
budget kills the tool and cleans unpublished output. Pull checks remote size
before downloading. Existing backups are never deleted to admit a new one.
Different configs pointing at the same storage must use the same quota policy.

The quota measures managed committed artifacts, not metadata, foreign files,
interrupted scratch data, image layers or sandbox volumes. Encryption temporarily
uses both plaintext and ciphertext; free-space admission budgets for both, and
remote decryption checks scratch space separately. `minimumFreeBytes` and actual
filesystem write errors are independent guards. Other processes can consume disk
concurrently; this is not a filesystem/project quota or a Docker VM disk quota.
Inspect stale `@storage-quota.lock` ownership after hard termination, following the
same recovery rules as project locks. Preview retention before applying cleanup.

## Discover and recover without the original catalog

```sh
restore-witness list example --remote --config recovery.json
restore-witness verify BACKUP_ID --remote --project example --config recovery.json
```

Listing follows S3 pagination and reads each committed encrypted manifest and
optional verification receipt. It ignores ciphertext without a commit marker.
Invalid project/environment/receipt metadata fails discovery. Limits are 10000
committed backups and 100 pages; an incomplete catalog never becomes a partial
retention plan. Bucket/prefix/credentials/project and age identity must be
recoverable independently of the lost local machine.

Successful remote verification now persists a matching-artifact `verification.json`
receipt in S3 as well as the local report. This requires PutObject permission in
addition to list/read access. The receipt binds the downloaded manifest and
ciphertext hash; a changed manifest refuses receipt publication. Receipt failure
is an operational error, not remote verification evidence. Failed verification
does not create successful evidence. Remote receipts, like local metadata, are
trusted operator-controlled records, not signed attestations.

## Remote retention

Configure a separate project policy; local `retention` is never reused implicitly:

```json
{
  "remoteRetention": {
    "timeZone": "Europe/Istanbul",
    "daily": 7,
    "weekly": 4,
    "monthly": 12
  }
}
```

```sh
restore-witness prune example --remote --config recovery.json
restore-witness prune example --remote --apply --config recovery.json
```

Preview does not write or delete S3 objects. It preserves newest, daily/weekly/
monthly buckets and the newest intact remotely verified backup. Deletion is
blocked without such a verified point. Previously verified backups need the new
remote receipt workflow before they can protect a remote retention plan.

Apply acquires `<prefix>/<project>/.retention-lock.json` with conditional creation,
probes conditional deletion on that owned lock with a deliberately wrong ETag,
validates the entire catalog's artifact bytes, then deletes exact candidates with
ETag conditions. A provider that accepts the wrong ETag is refused before backup
deletion. Required permissions include ListBucket, GetObject, PutObject and
DeleteObject. See [AWS conditional deletes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html).
Compatibility is tested against isolated RustFS; real AWS/R2 account acceptance
is separate. External clients/lifecycle policies must honor these recovery-point
protections; the tool cannot stop an administrator deleting objects independently.

Commit marker deletion precedes receipt/ciphertext removal. Cancellation or a
partial provider failure may leave uncommitted objects; completed deletions are
not rolled back. Inspect exact candidate paths and rerun discovery/preview.
Lock release uses its ETag and an independent cleanup deadline. Never remove a
held/stale remote lock without checking the owning operation. Old binaries do not
participate in this lock protocol; do not run mixed-version remote prune clients.
Unknown objects and incomplete multipart uploads are not deleted. Configure
provider lifecycle separately for incomplete multipart uploads. In versioned
buckets deletion can create markers and retain historical versions; reported
`reclaimableBytes` describes logical current artifacts, not guaranteed billed
storage reduction or permanent version erasure.

## Measured recovery drills

```sh
restore-witness drill example --config recovery.json
restore-witness drill example --remote --config recovery.json
```

A drill runs doctor, reads the explicitly configured source with pg_dump in
read-only mode, backs it up, optionally pushes to S3, and restores only in a
network-isolated disposable sandbox. It requires at least one table assertion.
It never writes source data or invokes a named restore target. Production sources
still incur read/IO load; choose the source and timing deliberately.

Reports in `drills/<project>/<id>.json` record source environment, backup/upload
and recovery timings, artifact data age at recovery completion and verification
checks. Recovery timing includes sandbox startup, restore, checks and cleanup;
remote timing additionally includes download/decryption and receipt publication.
It excludes operator reaction, host/tool setup, application startup and cutover.
Failures before a backup/report exists are command errors; inspect logs/catalog
and rerun. A failed verification produces a failed drill report and exit code 1.
This is a measured drill observation, not an SLA, PITR or incident-wide RPO/RTO.
