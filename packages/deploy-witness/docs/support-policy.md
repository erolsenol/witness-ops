# Support and compatibility policy

This policy describes the support level for DeployWitness `0.x` releases. It is
not a promise of a response time or a service-level agreement.

## Supported environments

| Surface | Supported baseline | Current validation |
| --- | --- | --- |
| CLI and public Node API | Node.js 22 or newer | CI on Node.js 22 and 24 |
| GitHub Action | GitHub-hosted runner with the `node24` Action runtime | Release and CI workflows |
| Operating systems | Linux runners | GitHub Actions CI uses Ubuntu; other operating systems may work but are not currently covered by CI |
| Providers | Coolify and Vercel read-only APIs | Shared contract tests use synthetic HTTP fixtures; authenticated live-provider E2E is not part of every release |

The CLI and Action require read-only provider credentials. DeployWitness does
not deploy or mutate provider resources. Provider support does not mean that a
provider exposes every capability: check the report's capability inventory and
the provider-specific limits in the README.

## Version and compatibility rules

DeployWitness is pre-1.0. Minor releases may change public behavior or APIs;
review the changelog and migration notes before upgrading. Patch releases are
reserved for fixes that do not intentionally change the documented config,
report, or Action contract.

Config and report documents carry explicit schema versions. A schema version
continues to accept only its documented fields. A breaking shape or decision
meaning requires a new schema version and migration guidance; consumers should
validate the version they receive and must not reinterpret a newer version as
an older one. See [JSON Schema contracts](../README.md#json-schema-contracts).

Only the latest `0.x` GitHub Release receives routine fixes. Security fixes
may require upgrading to that release. The `1.0.0` compatibility and support
policy will be published before a stable release.

## Reporting security issues

Use [GitHub private vulnerability reporting](https://github.com/erolsenol/deploy-witness/security/advisories/new)
for suspected vulnerabilities. Do not include provider tokens, customer data,
or other live secrets. Include the affected DeployWitness version and a
sanitized reproduction when possible. The maintainers will triage reports, but
there is no guaranteed response or remediation deadline.

For ordinary usage questions and defects, open a GitHub issue and include the
CLI/Action version, runtime, provider, and a redacted report or reproduction.
Never attach a raw report until checking it for internal URLs or other
environment details.
