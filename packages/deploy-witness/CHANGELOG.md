# Changelog

## 0.5.1 — 2026-10-06

- Reject malformed UTF-8 in provider JSON instead of accepting replacement characters as deployment evidence. Preserve valid multibyte characters split across streaming chunks.

## 0.5.0 — 2026-10-04

- Add shared Markdown reporting to the public API, CLI `verify`/`report --markdown`, and GitHub Action step summary. Escape report text and omit raw evidence values.
- Write report artifacts atomically with mode 0600. Preflight all output paths and reject overlaps with source config/report, duplicate paths, hard-link aliases and symlink/non-regular destinations.
- Config/report fields and decision exit codes remain unchanged. Existing artifact permissions are tightened to 0600 on replacement; Action summaries now use Markdown.

## 0.4.0 — 2026-10-04

- Add offline `report <path> --junit <path>` with verify-compatible decision exit codes.
- Export bounded UTF-8 saved-report loading and consistency validation; reject contradictory decisions, duplicate check IDs and empty/optional-only reports.
- Share terminal formatting and strip control characters from check summaries. Config and report schema fields remain unchanged.

## 0.3.0 — 2026-10-04

- Limit runtime probes to four concurrent workers by default while preserving config order in reports.
- Add `--probe-concurrency`, the Action `probe-concurrency` input, and the Node API `probeConcurrency` option (1–20).
- Reject probe names that collide after check ID normalization, including case, punctuation, fallback, and truncation collisions.
- Stream Coolify and Vercel JSON responses with a 2 MiB byte limit and the request deadline; cancel oversized, failed, and rejected response bodies.
- Preserve config v1/v2 fields, report v1, and verification exit codes. Migration: rename colliding probes and use concurrency 20 to restore the previous maximum parallelism.

## 0.2.8 — 2026-10-04

- Identify `erol.senol` as the package author.
- Require the `erol.senol` npm account for publishing and verify the recorded registry publisher.

## 0.2.7 — 2026-10-01

- Add a GitLab CI consumer example and setup notes for deployment correlation.
- Pin the README GitHub Action example to the v0.2.6 release commit.

## 0.2.6 — 2026-10-01

- Publish the first public npm package and document the npm CLI quick start.
- Add an opt-in Coolify staging acceptance workflow with positive and negative controls.
- Add report schema and provider-token redaction checks for staging runs.
- Configure npm release publishing for the `npm-publish` GitHub Environment and current Trusted Publishing CLI.

## 0.2.5 — 2026-10-01

- Define the security and compatibility boundary for a future opt-in GitHub artifact attestation verifier.

## 0.2.4 — 2026-10-01

- Document supported runtimes, current provider validation, 0.x compatibility, schema migration, and reporting policies.

## 0.2.3 — 2026-10-01

- Smoke-test the packed npm consumer install, CLI, config v2 schema, public API, and Action manifest in CI and release workflows.

## 0.2.2 — 2026-10-01

- Include valid observed runtime image digests in report evidence and distinguish missing, malformed, and mismatched markers.

## 0.2.1 — 2026-10-01

- Report the package version consistently from the CLI and JSON evidence reports.

## 0.2.0 — 2026-10-01

- Add config v2 with strict `deployment.expectedImageDigest` validation while preserving config v1.
- Add CLI, environment, and GitHub Action expected image digest overrides.
- Add runtime image digest marker verification through `imageDigestJsonPath`.
- Report provider image digest capability as unsupported when no observed immutable digest is available; never infer a digest from a mutable image tag.
- Publish config v1, config v2, and report v1 JSON Schemas and add digest evidence decision documentation.
- Compare SHA-256 hex markers case-insensitively while leaving other JSON marker comparisons unchanged.
- Add Node 22/24 CI, tag-verified GitHub releases, and a manual npm OIDC publishing workflow.
