import { spawn } from "node:child_process";
import {
  releaseRecordEvidenceSchema,
  type ReleaseEvidenceSnapshot,
  type ReleaseRecordEvidence,
  type RuntimeImageEvidence,
} from "@deploy-relay/contracts";
import { z } from "zod";

function createRemoteCommand(ledgerDirectory: string, webContainerName: string, mobileContainerName: string, imagePrefix: string): string {
  return `set -eu
ledger_directory="${ledgerDirectory}"
test -d "$ledger_directory"
record() {
  /usr/bin/jq -c --arg kind "$2" '{kind: $kind, sha, state, startedAt, finishedAt: (.finishedAt // null), images: [.images[]? | {name, reference, imageId}]}' "$1"
}
if [ -f "$ledger_directory/healthy.json" ]; then record "$ledger_directory/healthy.json" current; fi
find "$ledger_directory" -maxdepth 1 -type f -name '????????????????????????????????????????.json' -print | while IFS= read -r file; do record "$file" candidate; done
web_id="$(docker ps -q --filter name=${webContainerName})"
mobile_id="$(docker ps -q --filter name=${mobileContainerName})"
test -n "$web_id" && test -n "$mobile_id"
docker inspect "$web_id" "$mobile_id" --format '{{json .}}' | /usr/bin/jq -c --arg prefix "${imagePrefix}" '{kind: "runtime", logicalName: (.Config.Image | ltrimstr($prefix) | split(":")[0]), reference: .Config.Image, imageId: .Image, status: .State.Status, health: (.State.Health.Status // "none")}'`;
}

type CommandRunner = (target: string, command: string) => Promise<string>;

interface ReleaseEvidenceReaderOptions {
  readonly target?: string;
  readonly ledgerDirectory?: string;
  readonly webContainerName?: string;
  readonly mobileContainerName?: string;
  readonly imagePrefix?: string;
  readonly runner?: CommandRunner;
}

const lineKindSchema = z.enum(["current", "candidate", "runtime"]);
const runtimeImageSchema: z.ZodType<RuntimeImageEvidence> = z.strictObject({
  logicalName: z.enum(["web", "mobile"]),
  reference: z.string(),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.string(),
  health: z.string(),
});

function runSsh(target: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=yes",
      target,
      command,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 12_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 512_000) child.kill("SIGTERM");
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not start the release evidence connection."));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error("Release evidence is unavailable."));
    });
  });
}

export class ReleaseEvidenceReader {
  #cached: { readonly expiresAt: number; readonly snapshot: ReleaseEvidenceSnapshot } | null = null;

  private readonly target: string;
  private readonly ledgerDirectory: string | undefined;
  private readonly webContainerName: string | undefined;
  private readonly mobileContainerName: string | undefined;
  private readonly imagePrefix: string | undefined;
  private readonly runner: CommandRunner;

  constructor(options: ReleaseEvidenceReaderOptions = {}) {
    this.target = options.target ?? process.env.WITNESS_RELEASE_SSH_TARGET ?? "";
    this.ledgerDirectory = options.ledgerDirectory ?? process.env.WITNESS_RELEASE_LEDGER_DIRECTORY;
    this.webContainerName = options.webContainerName ?? process.env.WITNESS_RELEASE_WEB_CONTAINER;
    this.mobileContainerName = options.mobileContainerName ?? process.env.WITNESS_RELEASE_MOBILE_CONTAINER;
    this.imagePrefix = options.imagePrefix ?? process.env.WITNESS_RELEASE_IMAGE_PREFIX;
    this.runner = options.runner ?? runSsh;
  }

  async read(): Promise<ReleaseEvidenceSnapshot> {
    if (this.#cached && this.#cached.expiresAt > Date.now()) return this.#cached.snapshot;
    const checkedAt = new Date().toISOString();
    if (!/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+$/.test(this.target) ||
      !/^\/[A-Za-z0-9/_-]+$/.test(this.ledgerDirectory ?? "") ||
      !/^[A-Za-z0-9_-]+$/.test(this.webContainerName ?? "") ||
      !/^[A-Za-z0-9_-]+$/.test(this.mobileContainerName ?? "") ||
      !/^[A-Za-z0-9/_-]+$/.test(this.imagePrefix ?? "")) {
      return this.unavailable(checkedAt);
    }
    try {
      const output = await this.runner(this.target, createRemoteCommand(
        this.ledgerDirectory!, this.webContainerName!, this.mobileContainerName!, this.imagePrefix!,
      ));
      const records: ReleaseRecordEvidence[] = [];
      const runtimeImages: RuntimeImageEvidence[] = [];
      let current: ReleaseRecordEvidence | null = null;
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const envelope = z.record(z.string(), z.unknown()).parse(JSON.parse(line) as unknown);
        const kind = lineKindSchema.parse(envelope.kind);
        const payload = { ...envelope };
        delete payload.kind;
        if (kind === "runtime") runtimeImages.push(runtimeImageSchema.parse(payload));
        else {
          const record = releaseRecordEvidenceSchema.parse(payload);
          if (kind === "current") current = record;
          else records.push(record);
        }
      }
      const bySha = new Map<string, ReleaseRecordEvidence>();
      for (const record of records) {
        if (record.state === "healthy") bySha.set(record.sha, record);
      }
      if (current?.state !== "healthy") current = null;
      const rollbackCandidates = [...bySha.values()]
        .filter((record) => record.sha !== current?.sha)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      const runtimeMatchesCurrent = current === null ? null : (
        runtimeImages.length === current.images.length && current.images.every((image) =>
          runtimeImages.some((runtime) => runtime.logicalName === image.name && runtime.reference === image.reference &&
            runtime.imageId === image.imageId && runtime.status === "running" && runtime.health === "healthy"),
        )
      );
      const snapshot: ReleaseEvidenceSnapshot = {
        availability: "ready",
        checkedAt,
        current,
        rollbackCandidates,
        runtimeImages,
        runtimeMatchesCurrent,
        error: null,
      };
      this.#cached = { expiresAt: Date.now() + 30_000, snapshot };
      return snapshot;
    } catch {
      return this.unavailable(checkedAt);
    }
  }

  private unavailable(checkedAt: string): ReleaseEvidenceSnapshot {
    return {
      availability: "unavailable",
      checkedAt,
      current: null,
      rollbackCandidates: [],
      runtimeImages: [],
      runtimeMatchesCurrent: null,
      error: "Release ledger could not be read or validated.",
    };
  }
}

export function isVerifiedRollbackCandidate(snapshot: ReleaseEvidenceSnapshot, sha: string): boolean {
  return snapshot.availability === "ready" && snapshot.runtimeMatchesCurrent === true &&
    snapshot.rollbackCandidates.some((candidate) => candidate.sha === sha && candidate.state === "healthy");
}
