# Security boundaries

WitnessOps is a local operator tool. Its HTTP agent binds only to `127.0.0.1`, checks local Host and Origin values, requires a random session token for every operational API call, and requires `X-Witness-Request: 1` for writes. Keep the session URL private. These checks do not isolate processes running as the same operating-system user. Do not expose the port through a public proxy.

The project catalog is trusted local configuration. It may name native release commands and absolute config paths, so protect it with local account permissions and never commit a real catalog. Browser requests cannot supply commands, filesystem paths, provider tokens, or database credentials. Provider tokens and database connection URLs come from environment variables referenced by private config files.

DeployWitness uses read-only provider access. Its provider response, runtime probes, and report have distinct evidence meanings. A public HTTP success alone is not proof of the expected commit or image digest. RestoreWitness separates successful backup creation, artifact integrity, isolated restore, and application assertions. A passing report is an observation at a point in time.

Release jobs use a shared SQLite operation lock across the CLI and app processes. A concurrent operation waits for the first to finish before it starts. Uncertain deploy or rollback outcomes become `needs_attention`; the agent never retries them automatically. RestoreWitness's explicit restore command still refuses known source matches and nonempty targets. Database drill uses a disposable sandbox.

The SQLite journal and report files are local operational data. Reports may include endpoint names, identifiers, and recovery metadata. The console serves them only from a fixed report directory for known run IDs. Keep the data directory private and do not attach reports to public issues.

Remote browser use requires SSH access on both ends. The Mac remains the executor and the agent remains bound to loopback. See [SSH access](docs/REMOTE.md).
