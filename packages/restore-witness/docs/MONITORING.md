# Monitoring and opt-in webhook delivery

`restore-witness monitor <project>` reads local catalog, report and job metadata,
hashes the latest artifact and the artifact with the most recent passing restore
report, and checks available disk space. It does not connect to the source database,
run a new restore drill, or check remote S3 availability. JSON reports include
independent backup/verification ages and thresholds. The default limits are one
day for backups and seven days for verification; age exactly equal to a limit is
accepted. Configure project `monitoring` to change them.

Alerts cover missing/stale backups and verification, a failed latest verification,
artifact or metadata problems, mismatched environments, future timestamps more
than a minute ahead, disk admission limits, and scheduled job failures. Interrupted
jobs always alert. A running job alerts after the configured command timeout plus
30 seconds. Failed scheduled jobs additionally alert when their retry limit or
local-date retry window is exhausted. Historical failed jobs are superseded by a newer slot of the same
kind; abandoned latest slots remain visible as failures. The monitor takes a
best-effort local snapshot, not a transaction across concurrent catalog changes.
Run it after scheduled work and retry a transient unavailable/corruption result
before manual cleanup.

## Configuration

```json
{
  "monitoring": {
    "maximumBackupAgeSeconds": 86400,
    "maximumVerificationAgeSeconds": 604800
  },
  "notification": {
    "webhookUrlEnv": "RECOVERY_WEBHOOK_URL",
    "bearerTokenEnv": "RECOVERY_WEBHOOK_TOKEN",
    "timeoutSeconds": 10,
    "retryDelaySeconds": 60
  }
}
```

These fields belong inside a configured project. `bearerTokenEnv` is optional.
The URL value stays in the named environment variable; paths/query strings can
contain provider secrets. HTTPS is mandatory, with explicit loopback-only HTTP
through `allowInsecureLocalEndpoint` for disposable tests. User/password URL
credentials and fragments are rejected. Redirects are never followed. Use a
receiver that accepts this generic JSON contract; there are no native Slack,
email, Discord, or other provider-specific adapters in this release.

```sh
restore-witness monitor example --config /absolute/path/restore-witness.json
# Explicitly enable delivery for this invocation:
restore-witness monitor example --notify --config /absolute/path/restore-witness.json
```

Use your external timer to run the explicit command at an interval appropriate
for your host. Configuring notification fields alone does not send anything.
`tick`, `backup`, `verify`, `status`, and a plain `monitor` never deliver webhooks.
Provide referenced secrets to the timer process using your own secret manager.
No real projects or production receivers are enabled by installing this package.

## Receiver contract

POST `Content-Type: application/json`. Optional `Authorization: Bearer ...`.
`Idempotency-Key` equals the event's UUID `id`.

```json
{
  "version": 1,
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "project": "example",
  "observedAt": "2026-10-07T08:00:00.000Z",
  "healthy": false,
  "alerts": [{ "code": "backup-stale", "subject": "backup-uuid" }]
}
```

Subjects are backup UUIDs or scheduled job IDs where applicable. Only condition
codes and project/job/backup identifiers leave the host. Database URLs, row/table
contents, assertion names, native-tool errors, credentials, ages, and disk figures
are excluded from the event. Any 2xx response acknowledges HTTP acceptance, not
an end-user notification or provider processing outcome. Response bodies are
canceled without parsing or forwarding their contents.

Each invocation makes at most one request, bounded by the configured timeout and
CLI cancellation. `notifications/<project>.json` stores private delivery state;
URL/token values are not stored. A fingerprint of condition codes and subjects
suppresses unchanged states even as their ages grow. Initial healthy observations
are silent; recovery from a delivered or uncertain pending alert sends an empty
healthy event. Changed conditions or a changed endpoint create a new event.

Before POST, the exact payload and event UUID are saved. A failed/uncertain request
remains pending and retries on a later explicit invocation after backoff, using
the same ID/body. A changed state replaces an obsolete pending event with the
latest observation. A process crash after HTTP acceptance but before the receipt
write can cause a duplicate; receivers should persist and deduplicate IDs. This
is not an exactly-once or durable external provider guarantee. Notifications are
not reminders: an acknowledged unchanged failure remains silent indefinitely.

Notification statuses are `delivered`, `unchanged`, `initial-healthy`, `failed`,
and `retry-pending`. CLI exit 0 requires a healthy report and no failed/pending
delivery; exit 1 indicates unhealthy recovery or a delivery problem; exit 2 is
usage error. A delivered failure alert still returns 1. Inspect both report and
notification status rather than treating exit 1 as proof of HTTP failure.

## Interrupted delivery

Inspect `.locks/notify-<sha256-of-project-first-32-hex>.lock/owner.json` before
removing an exact stale lock. Preserve the pending event to retain its receiver
idempotency identity. Corrupt or symlinked state fails closed before delivery.
Do not delete state casually: doing so loses suppression and delivery history.
No automatic stale-lock cleanup, remote provider pilot, or message delivery to a
real recipient is performed by the test suite.

The v0.5 monitor also reports `verifiedBackupAgeSeconds` and compares it with
`maximumVerifiedBackupAgeSeconds` (default 86400). A fresh verification of old
data can produce `verified-backup-stale`. See [MVP operations](MVP.md) for data-age
selection, quota alerts and migration behavior.
