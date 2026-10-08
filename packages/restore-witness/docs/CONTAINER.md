# Container distribution

Download the Linux image archive for your CPU from the GitHub release, together
with `SHA256SUMS`, `IMAGE-ID-<architecture>` and `IMAGE-METADATA-<architecture>.json`.
Apple Silicon/ARM servers use `arm64`; Intel/AMD machines use `amd64`. macOS still
needs a working Linux Docker VM. These are Docker-loadable release archives,
not published registry/GHCR tags and not a bundled database/daemon.

Example for ARM64 (substitute amd64 on other hosts):

```sh
shasum -a 256 -c SHA256SUMS
# Or use sha256sum -c SHA256SUMS on Linux. All listed assets must be present.
VERSION=0.5.0-alpha.5
gzip -dc "restore-witness-$VERSION-linux-arm64.tar.gz" | docker load
IMAGE="restore-witness:$VERSION-arm64"
# Select the matching architecture below.
ACTUAL_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
test "$ACTUAL_ID" = "$(cat IMAGE-ID-arm64)" || \
  test "$ACTUAL_ID" = "$(cat OCI-MANIFEST-ID-arm64)"
docker run --rm "$IMAGE" --version
```

`IMAGE-ID-*` records the CI classic image store's configuration digest.
`OCI-MANIFEST-ID-*` records the archive's OCI manifest digest, which references
that same configuration and its layers. Containerd image stores can report the
manifest digest as `docker image inspect .Id`; either exact published identity
is valid for these single-platform archives. Both identities are independently
hashed from the archive and covered by `SHA256SUMS`. This distinction follows
[Moby's containerd implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go)
and the [Docker image specification](https://github.com/moby/docker-image-spec/blob/main/spec.md).

Archives name the exact architecture and version. OCI labels include the source
revision. The image includes Node.js 24, native PostgreSQL clients 16/17/18, age
1.x, and Docker CLI 29. Select the matching client major through
`RW_POSTGRES_MAJOR` (default 18); invalid choices exit 2. An explicit configuration
`postgresBinDirectory` still overrides PATH; omit it when using this selector.
Native version checking still rejects a mismatch with the source or archive.

## Local catalog and backup

Create a dedicated working directory owned by the runtime UID. Mount it at
`/work`. The image defaults to UID/GID 10001; on Linux/macOS bind mounts use your
own IDs if needed. Store config, private recovery identity, and backups outside
the ephemeral container. Mount identity read-only separately if it is outside
that directory. Use an encrypted/protected working disk.

```sh
mkdir -p recovery-work
chmod 700 recovery-work
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" -v "$PWD/recovery-work:/work" "$IMAGE" init
# Edit recovery-work/restore-witness.json and its secret environment references.
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" -v "$PWD/recovery-work:/work" \
  -e RW_POSTGRES_MAJOR=16 -e EXAMPLE_DATABASE_URL "$IMAGE" backup example
```

Pass variables by name (`-e NAME`) from your secret manager/session, not literal
secret values in shared command history. Container `localhost` refers to itself:
configure a reachable explicit host or a dedicated Docker network for your source.
The tool never sets up production networking or database containers. S3 and
webhook operations require outbound connectivity to their configured endpoints.

`monitor`, `status`, `jobs`, `prune`, `push`, `pull`, and named native target
`restore` use the same CLI contracts. Daily operation still needs an external
timer. `--read-only` protects the image filesystem, not writable mounted backups;
explicit `prune --apply` can delete those local mounted artifacts.

## Isolated verification and Docker access

`verify`, `verify --remote`, `doctor`, and scheduled verification need a Docker
daemon plus an explicitly pre-pulled matching PostgreSQL image. The CLI image
contains a Docker client, not a daemon or database server. To use a local daemon,
explicitly mount its socket and grant the runtime process its socket group:

```sh
docker pull postgres:16
# Linux example; adapt the exact socket path/group for your own Docker VM.
SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" --group-add "$SOCKET_GID" \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/recovery-work:/work" \
  -e RW_POSTGRES_MAJOR=16 -e EXAMPLE_DATABASE_URL -e RECOVERY_IDENTITY_FILE \
  "$IMAGE" verify <backup-id>
```

Docker socket access permits powerful host/daemon operations regardless of the
container's non-root UID. Use only on a trusted dedicated recovery host; never
expose the socket over an unauthenticated network. `doctor` also needs the source
connection; ordinary verification uses the backup, identity and daemon without
querying the source. macOS socket/group paths depend on the selected Docker VM.
No host path is guessed or mounted automatically by RestoreWitness.

The backup is streamed through Docker exec stdin, so verification does not bind
its filesystem into the sandbox. Sandbox database containers retain existing
network/cleanup isolation and use the configured [sandbox resource limits](SANDBOX.md).
Check BOTH mounted working-disk capacity and
the daemon's own image/volume disk capacity; the host free-space guard cannot
measure a separate Docker VM's disk. A full VM causes failed verification.

## Build and evidence

Build from the release source using its exact version/revision:

```sh
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')
docker build --build-arg VERSION="$VERSION" --build-arg REVISION="$(git rev-parse HEAD)" \
  -t "restore-witness:$VERSION-local" .
```

Both official base images are pinned by digest. Apt package feeds remain mutable,
so a source rebuild is not claimed to reproduce identical image bytes. Released
archives carry their actual image IDs, metadata and checksums. The allowlist build
context excludes local configs, backups, identities, environment files and Git
history. Dependencies are installed from the npm lockfile; runtime dev dependencies
are removed. The image defaults to a non-root user and never bundles credentials.
Docker CLI's Apache license is included under `/app/licenses`; native package
licenses remain under `/usr/share/doc` and Node comes from its official base.

Native AMD64 and ARM64 CI runners independently build/test the images against
PostgreSQL 16/17/18. They exercise encrypted backup, real sandbox restore, healthy
monitoring and corruption detection, then export, remove and reload the artifact
and check the version. Fixtures use disposable databases/networks/identities;
there is no production/provider pilot in this test. Registry image distribution
and npm Trusted Publishing remain separate milestones. The npm package itself
is published separately from these image archives.
