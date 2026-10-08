# Changelog

## 0.5.0-alpha.5 — 2026-10-08

- Added explicit, preview-first compaction of old terminal scheduled-job records.
- Protected running, interrupted, retry-pending and newer job records; compaction
  leaves backup artifacts and verification reports untouched.
- Real AWS/R2 account acceptance, prolonged timer reliability, and application
  startup/cutover validation remain open MVP readiness work.

## 0.5.0-alpha.4 — 2026-10-08

- Corrected the npm package scope to match the authenticated npm account and
  published the CLI as `@erol.senol/restore-witness` with the `alpha` tag.
- Verified registry metadata and a clean consumer install reporting
  `0.5.0-alpha.4`.
- Kept real AWS/R2 acceptance, prolonged timer reliability, and
  application startup/cutover validation as open MVP readiness work.

## 0.5.0-alpha.3 — 2026-10-08

- Prepared a scoped CLI package for npm publication; registry publication did
  not complete because the original npm scope was unavailable.
- Aligned release documentation with current recovery evidence. AWS/R2 account
  acceptance, prolonged timer reliability, and application startup/cutover
  validation remain open.

## 0.5.0-alpha.2 — 2026-10-07

- Reconciled the README with implemented remote retention and recovery receipts.
- Prepared installable CLI distributions for npm and GitHub; container archive
  distribution remains a separate channel.
- Real AWS S3/R2 acceptance, prolonged timer reliability, and application-level
  recovery/cutover validation remain MVP readiness work.

## 0.5.0-alpha.1 — 2026-10-07

- Verified recovery-point data-age alerts, conservative snapshot-start timestamps
  and independent report/backup freshness thresholds.
- Remote catalog discovery without local copies, matching-artifact verification
  receipts and explicit dry-run/apply S3 retention protecting recovery points.
- Conditional remote lock/deletes with capability probe, pre-deletion artifact
  validation and marker-first removal.
- Shared committed-artifact quotas with bounded streaming dump/encryption output,
  quota-aware pulls and storage usage monitoring.
- Measured read-only-source recovery drills with durable timings and real-project
  Recovery pilot evidence and operational limits were documented.

## 0.4.0-alpha.3 — 2026-10-07

- Bounded configurable sandbox memory, CPU and process limits with existing
  defaults and explicit disabled swap.
- Docker configuration inspection before database start; mismatched resource or
  network limits fail verification and still clean up.
- Persisted validated resource profiles, backwards-compatible historical reports,
  boundary/lifecycle tests and real PostgreSQL/container coverage.

## 0.4.0-alpha.2 — 2026-10-07

- Docker-loadable AMD64/ARM64 distribution images with digest-pinned Node/Docker
  bases, PostgreSQL 16/17/18 clients, age, and a non-root default runtime.
- Allowlisted build context, exact version/revision labels, native client selector,
  preserved licenses, offline installation and daemon/socket guidance.
- Native architecture CI checks encrypted backups, actual sandbox restores,
  monitoring/corruption detection across all supported PostgreSQL majors, and
  exported-image remove/reload installation.
- Registry publication, npm Trusted Publishing and production pilots remain separate.


## 0.4.0-alpha.1 — 2026-10-07

- Read-only local recovery monitoring for independent backup/verification ages,
  artifact integrity, job failures/interruption, metadata and disk issues.
- Explicit generic HTTPS webhook delivery, secret environment references,
  condition-based suppression, recovery events, persisted event IDs/body and
  bounded request timeout with later-invocation backoff.
- Receiver contract, monitored configuration, transport failure/privacy tests,
  and real PostgreSQL restored-dump monitoring coverage.
- Container/npm distribution and real-project/provider pilots remain separate,
  unfinished milestones. Existing operational features remain backwards compatible.


## 0.3.0-alpha.1 — 2026-10-07

- Timezone-aware daily `tick`, backup/upload and verification jobs with durable
  history, bounded same-day retries, and explicit interrupted-slot acknowledgment.
- Local daily/weekly/monthly retention plans and opt-in deletion protecting the
  newest backup and newest intact verified recovery point.
- Configurable backup free-space admission floor, timer/recovery documentation,
  DST/retry/deletion tests, and real PostgreSQL scheduled restore/retention tests.
- External timers remain required. Remote deletion, storage quotas, configurable
  sandbox resource profiles, and job-history compaction remain future work.


## 0.2.0-alpha.1 — 2026-10-07

- Optional native age X25519 encryption with v2 manifests and v1 compatibility.
- S3-compatible streaming upload/download with explicit credential references.
- Content-addressed objects, conditional commit markers, and interrupted-upload recovery.
- Remote verification/restore without an original local backup copy.
- Private recovery identity checks and temporary plaintext cleanup.
- Real age tests, signed-HTTP failure tests, and RustFS/PostgreSQL recovery coverage.

Scheduling, retention deletion, notifications, and a dashboard remain future work.

## 0.1.0-alpha.1 — 2026-10-07

- Local PostgreSQL 16–18 logical backups with atomic manifests and checksums.
- Strict configuration, environment secret references, and prerequisite checks.
- Isolated Docker restore verification and minimum-row assertions.
- Explicit empty development/test target restore without clean/drop operations.
- JSON catalog/status/report output, job locks, deadlines, and cancellation.
- Unit and real PostgreSQL integration tests, recovery documentation, and package artifact.

Scheduling, retention deletion, encryption, S3, and npm publication are separate
future milestones.
