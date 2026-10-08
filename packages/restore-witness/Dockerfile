FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM docker:29-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c AS docker-cli
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/erolsenol/restore-witness" \
      org.opencontainers.image.title="RestoreWitness" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 postgresql-client-17 postgresql-client-18 age \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 witness && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp witness \
    && mkdir /work && chown witness:witness /work
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /build/dist /app/dist
COPY --from=build /build/node_modules /app/node_modules
COPY package.json LICENSE /app/
COPY container/LICENSE.docker-cli /app/licenses/docker-cli.txt
COPY container/entrypoint.sh /usr/local/bin/restore-witness-container
RUN node -e 'if (JSON.parse(require("fs").readFileSync("/app/package.json")).version !== process.argv[1]) process.exit(1)' "$VERSION" \
    && chmod 755 /usr/local/bin/restore-witness-container
ENV RW_POSTGRES_MAJOR=18 HOME=/tmp
WORKDIR /work
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/restore-witness-container"]
CMD ["--help"]
