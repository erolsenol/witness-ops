# Coolify staging validation

This opt-in workflow exercises the GitHub Action against a non-production
Coolify application. It performs read-only requests and does not trigger,
restart, or modify deployments. Do not configure it with a production resource.

## Prerequisites

The staging application must:

- be publicly reachable over HTTPS;
- expose a health URL that returns HTTP 200;
- expose a version URL whose JSON contains the deployed full commit SHA (default
  path: `commit`);
- have a completed Coolify deployment whose creation time is after the supplied
  `started_after` timestamp.

Create a GitHub Environment named `staging`. Add the following environment
variables and one read-only secret:

| Name | Value |
| --- | --- |
| `DW_STAGING_COOLIFY_BASE_URL` | Coolify HTTPS origin |
| `DW_STAGING_COOLIFY_RESOURCE_UUID` | Non-production application UUID |
| `DW_STAGING_HEALTH_URL` | Public health endpoint |
| `DW_STAGING_VERSION_URL` | Public version JSON endpoint |
| `DW_STAGING_VERSION_JSON_PATH` | Optional JSON path; defaults to `commit` |
| `DW_STAGING_COOLIFY_TOKEN` secret | Read-only Coolify API token |

## Run and acceptance checks

Deploy a commit to the staging application and capture the UTC timestamp
immediately before that deploy step. In GitHub Actions, run **Coolify staging
E2E** with that full SHA and timestamp, then explicitly confirm that the
configured resource is non-production. The workflow refuses to build configs
without this confirmation. It runs three controls:

1. The expected deployment SHA and runtime marker both pass.
2. A deliberately altered expected SHA fails specifically at the provider
   commit check.
3. The correct provider SHA with a deliberately wrong runtime marker fails the
   HTTP marker check.

Every report is checked against report v1 and scanned for the configured
provider token. Reports stay on the ephemeral runner and are not uploaded as
artifacts. Retain only the workflow run link and a separately reviewed,
redacted report as release evidence.

This workflow requires a real staging application and credentials. Contract
fixtures or a successful build do not count as authenticated provider E2E.
