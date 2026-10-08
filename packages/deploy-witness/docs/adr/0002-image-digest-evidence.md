# ADR 0002: Image digest evidence boundaries

- **Status:** Accepted
- **Date:** 2026-10-01
- **Scope:** Config v2 and report v1; applies to all deployment providers and runtime probes.

## Context

An expected OCI digest can identify immutable image content, but providers may expose only the configured image name or tag rather than the digest resolved for a specific deployment. Treating a tag or deployment reference as the observed digest would overstate the evidence.

## Decision

- Config v2 optionally accepts `deployment.expectedImageDigest` in the exact `sha256:<64 hexadecimal characters>` form. A v2 HTTP probe can set `imageDigestJsonPath`; that path is compared with the same configured expected digest without copying it into every probe. Config v1 remains unchanged and strict; new `init` output uses v2.
- CLI and Action inputs override `DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST`, which overrides the config value.
- The provider digest check is required when an expected digest is supplied. It passes only for an exact normalized digest match, fails on a mismatch, and is UNKNOWN for missing or malformed observations. If the adapter cannot read a deployment-scoped immutable digest, it reports required `UNSUPPORTED`; this makes the overall result `INCOMPLETE`.
- Configured image tags, references, labels, and build arguments do not count as observed provider digests.
- A runtime marker is a separate HTTP check. Matching the expected digest at runtime does not replace provider-side digest evidence; a mismatch remains a required failure.
- A valid runtime marker records normalized expected and observed digests. Missing and malformed observations record `null` and use failure codes distinct from a valid digest mismatch.
- Report v1 needs no shape change: digest results use the existing check and scalar evidence contract.

## Consequences

- Existing config v1 consumers continue to work. Consumers adopting the digest field must move to config v2 and validate against `schemas/config-v2.schema.json`.
- Current Coolify and Vercel deployment response contracts do not expose an observed immutable image digest in the fields used by DeployWitness. Their digest capability is therefore `UNSUPPORTED` until an adapter can verify a deployment-scoped value.
- The shared evaluator covers positive, mismatch, missing, malformed, and unsupported outcomes so a future adapter can add observed digest support without introducing provider-specific decision logic.
