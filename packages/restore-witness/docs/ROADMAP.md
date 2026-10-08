# Roadmap

Unchecked items are not implemented. Source releases, npm publication, and
container archive publication are separate milestones.

## v0.1 alpha: local PostgreSQL recovery workflow

- [x] Strict configuration and explicit project/environment identities
- [x] PostgreSQL 16–18 native logical dumps and matching-major tool checks
- [x] Bounded subprocess execution, cancellation, and restore input streaming
- [x] Atomic local catalog, SHA-256, sizes, timestamps, versioned manifests
- [x] Isolated Docker restore with resource limits and cleanup
- [x] Catalog checks and manifest-defined minimum-row assertions
- [x] Named empty development/test target restore
- [x] Reports and status with distinct backup/verification outcomes
- [x] Unit tests and real PostgreSQL integration suite
- [x] CI matrix for PostgreSQL 16, 17, and 18
- [x] Recovery guide and installable package artifact

## v0.2 alpha: protected remote recovery

- [x] Maintained encryption format, key references, and key recovery guide
- [x] S3-compatible streaming storage and interrupted-upload handling
- [x] Restore drills using downloaded remote artifacts
- [x] Recovery in a clean environment without any local backup copy

## v0.3: scheduled operations and retention

- [x] Explicit timezone-aware daily backup and verification schedules (external timer)
- [x] Durable job history, bounded same-day retries, and explicit interrupted-job acknowledgment
- [x] Daily/weekly/monthly local policy evaluation with deletion dry runs
- [x] Protect the newest backup and intact locally verified recovery point during retention
- [x] Configurable backup free-space admission floor
- [x] Configurable sandbox memory/CPU/process limits with runtime inspection and report evidence
- [x] Streaming backup/pull admission against a shared committed-artifact quota
- [x] Explicit, preview-first compaction of old terminal job history
- [x] Explicit remote retention with discovery, verification receipts and conditional deletion
- [ ] Non-daily schedule expressions

## v0.4: operations and distribution

- [x] Local recovery health reports and opt-in webhooks for failures, stale backups, and operator action
- [x] Durable notification identities, backoff, unchanged-state suppression and recovery events
- [ ] Prolonged real-project timer reliability and application/cutover RPO/RTO validation
- [x] Public npm package publication (`@erol.senol/restore-witness`, `alpha` dist-tag; trusted publishing/provenance remains a follow-up)
- [x] Public Docker-loadable AMD64/ARM64 release images and real end-to-end install checks
- [ ] Registry image distribution with verified anonymous pulls

## Later

- [ ] Optional management dashboard
- [ ] Additional database/storage adapters based on actual usage
- [ ] Physical backup/PITR integrations evaluated independently of logical dumps
- [ ] Stronger artifact authenticity and multi-user boundaries
