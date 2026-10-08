# Sandbox resources

Restore verification starts a disposable, matching-major PostgreSQL container.
Local, remote and scheduled verification all use the same root configuration:

```json
{
  "version": 1,
  "sandboxResources": {
    "memoryMiB": 1024,
    "cpus": 2,
    "pidsLimit": 256
  },
  "projects": {
    "example": {
      "environment": "test",
      "connectionEnv": "EXAMPLE_DATABASE_URL"
    }
  }
}
```

| Setting | Default | Accepted values |
| --- | --- | --- |
| `memoryMiB` | 512 | Whole MiB, 256–65536 |
| `cpus` | 1 | 0.25–32, multiples of 0.25 |
| `pidsLimit` | 256 | Whole processes/threads, 32–4096 |

Omit the object or individual fields to retain defaults. Unknown keys, strings,
fractional MiB/process counts and unlimited values are rejected during config
loading. These are per-sandbox ceilings, not reserved host capacity or limits on
backup/age/client processes. Separate project jobs can run concurrently; size
host/VM capacity for their combined limits. Bigger ceilings do not ensure a large
dump will finish within `timeoutSeconds` (maximum 3600).

Swap is disabled by explicitly setting Docker `--memory-swap` equal to `--memory`,
as described in [Docker's resource documentation](https://docs.docker.com/engine/containers/resource_constraints/).
This is a change from earlier implicit Docker swap behavior. Memory pressure may
cause a failed restore; increase the configured memory only when host capacity
allows it. Shared buffers remain 32 MiB, connections remain capped at 10, and
restore remains single-transaction and serial.

After creation, RestoreWitness checks Docker's stored `Memory`, `MemorySwap`,
`NanoCpus`, `PidsLimit` and `NetworkMode` before starting PostgreSQL. A mismatch or
unreadable inspection fails verification and triggers cleanup. This inspection
confirms daemon configuration; it does not prove kernel cgroup enforcement on
hosts lacking the relevant capabilities. Use a supported Docker/Linux runtime.

Successful sandbox admission adds `sandboxResources` and a `sandbox-limits` check
to the verification report. The profile records that run's validated settings,
not the current config when reading history. Old reports without this field remain
readable. Resource details may be present even when a later restore/assertion
fails; always inspect the report's `passed` value and checks. A failure before
sandbox admission has no resource evidence.

Isolation is fixed: no network, published ports, host filesystem mounts or
privileged mode. The archive streams through Docker exec stdin. Resource overrides
do not change isolation, image selection or cancellation cleanup. Anonymous
volumes and the container are removed; cleanup failure invalidates verification.
Sandbox data on Docker's storage is plaintext while verification runs.

Unit tests cover invalid boundaries, daemon mismatches, cancellation and cleanup
failure. Opt-in integration tests inspect real Docker settings, query PostgreSQL
and verify persisted reports for all three supported majors. Native AMD64 and
ARM64 image smoke tests use 640 MiB, 0.5 CPU and 128 processes during encrypted
backup recovery. No application or production database is selected implicitly.
