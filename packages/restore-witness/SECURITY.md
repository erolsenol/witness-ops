# Security policy

## Supported version

The latest `0.5.0-alpha` prerelease is the only maintained release line.
This is experimental software; it is not a complete production recovery system.

## Boundaries

- Local encryption is opt-in; S3 uploads require encrypted v2 artifacts.
- Plaintext exists during dump/decryption. Protect disks and working-directory access;
  unlinking temporary files is not secure erasure or protection from snapshots.
- age authenticates encrypted content; separate manifests remain unsigned/unencrypted.
- Keep recovery identities separately protected. Losing all matching identities
  makes encrypted recovery impossible.
- Config, storage directories, manifests, native tool paths, and Docker daemon are
  trusted operator-controlled inputs. Manifests are not signed.
- Use environment/secret-manager references for database/S3 credentials. Recovery
  identities are referenced through private regular files, never inline secrets.
- S3 endpoints require HTTPS except explicit loopback HTTP test endpoints. SDK
  ambient credential chains and endpoint overrides are disabled.
- Never restore untrusted PostgreSQL dumps: they can contain executable code.
- Verification containers have no network or host directory mounts. Resource
  limits reduce load; Docker daemon and filesystem boundaries still apply.
- Empty-target validation and environment labels are not a server authorization
  or identity system. Review target connections before an explicit restore.
- Errors exclude database stderr and connection URLs. Manifest/report metadata
  includes project IDs, timestamps, and assertion table/schema names.

- Local retention deletion requires explicit `prune --apply`, protects the newest
  backup and newest intact verified recovery point, and checks artifacts before
  deletion. Trusted metadata is not cryptographically signed evidence.
- Interrupted scheduled jobs require explicit acknowledgment; stale locks are
  never automatically removed. Timer credentials remain operator-managed.

- Webhook delivery requires explicit `monitor --notify` and an operator-controlled
  HTTPS endpoint. Redirects are refused; endpoint and token values are not stored
  in notification state or returned in errors. Payloads still include project
  identifiers, backup/job IDs and condition codes; choose receivers accordingly.
- Local monitor snapshots and HTTP acceptance do not prove a fresh restore,
  remote object availability, or downstream provider/end-user notification.

- Distribution images default to a non-root UID and an allowlisted build context.
  Explicit Docker socket access still grants powerful daemon/host privileges.
  Use trusted dedicated recovery hosts and keep mounted configuration/identities
  protected. Separate Docker VM capacity is not covered by host disk checks.

## Private reporting

Use [GitHub private vulnerability reporting](https://github.com/erolsenol/restore-witness/security/advisories/new).
If unavailable, use the contact on the maintainer's
[GitHub profile](https://github.com/erolsenol) to request a private channel before
sharing sensitive details. Do not include credentials or database contents in
public issues or pull requests.

- Remote retention requires explicit policy and apply, a conditional remote lock,
  provider conditional-delete support, a verified protected point and artifact
  validation. Commit markers are removed first; interruption can leave orphan
  ciphertext/receipts. Versioned buckets may retain historical versions.
- Recovery drills read the explicitly selected source and write only to local/S3
  backup storage and disposable sandboxes. Published pilot evidence excludes
  connection strings, rows, keys and tenant/business counts.
