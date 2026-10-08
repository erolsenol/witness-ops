# Architecture

The `witness` CLI routes release operations to the local agent, deploy verification to the DeployWitness engine, and database operations to the RestoreWitness engine. The web console and Electron window use the same loopback agent. Internal workspace packages are private; only the root npm package is published.

The agent validates local project catalogs, owns the serial scheduler and SQLite journal, and accepts only allowlisted project actions with a session token. A shared SQLite operation lock prevents separate CLI and app processes from running jobs concurrently. Project adapters invoke each repository's native build and receiver commands; WitnessOps does not reimplement those deployment contracts. Checks run under the configured `dev-run` lock when present. An interrupted job remains `needs_attention` until an operator inspects it.

Deploy verification reports compare provider deployment records, expected SHA, freshness, and independent runtime probes. Database drills back up a configured source read-only and restore in an isolated sandbox. When configured as release gates, a failed database drill prevents deploy, and a failed post-deploy check marks the run for attention.

The optional SSH release evidence reader runs one locally configured read-only query for receiver ledger records and exact Docker image IDs. It only offers rollback candidates when the current ledger and runtime images agree. The native receiver remains the final rollback authority.
