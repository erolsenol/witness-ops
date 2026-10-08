import { describe, expect, it } from "vitest";
import { isVerifiedRollbackCandidate, ReleaseEvidenceReader } from "./release-evidence.ts";

const currentSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const imageId = `sha256:${"1".repeat(64)}`;
const evidenceOptions = { ledgerDirectory: "/var/lib/example", webContainerName: "web-example", mobileContainerName: "mobile-example", imagePrefix: "local-release/example-" } as const;

function record(sha: string, kind: "current" | "candidate") {
  return JSON.stringify({
    kind,
    sha,
    state: "healthy",
    startedAt: "2026-10-08T00:00:00.000Z",
    finishedAt: null,
    images: [
      { name: "web", reference: `local-release/example-web:sha-${sha}`, imageId },
      { name: "mobile", reference: `local-release/example-mobile:sha-${sha}`, imageId },
    ],
  });
}

const runtime = (logicalName: "web" | "mobile", sha: string) => JSON.stringify({
  kind: "runtime",
  logicalName,
  reference: `local-release/example-${logicalName}:sha-${sha}`,
  imageId,
  status: "running",
  health: "healthy",
});

describe("ReleaseEvidenceReader", () => {
  it("compares exact runtime image identities and lists only prior healthy releases", async () => {
    let calls = 0;
    const reader = new ReleaseEvidenceReader({ target: "root@host.example", ...evidenceOptions, runner: async (_target, command) => {
      calls += 1;
      expect(command).toContain("healthy.json");
      expect(command).toContain("docker inspect");
      return [record(currentSha, "current"), record(previousSha, "candidate"), runtime("web", currentSha), runtime("mobile", currentSha)].join("\n");
    } });

    const snapshot = await reader.read();
    const cached = await reader.read();
    expect(snapshot.availability).toBe("ready");
    expect(snapshot.current?.sha).toBe(currentSha);
    expect(snapshot.rollbackCandidates.map((candidate) => candidate.sha)).toEqual([previousSha]);
    expect(snapshot.runtimeMatchesCurrent).toBe(true);
    expect(snapshot.runtimeImages).toHaveLength(2);
    expect(cached).toBe(snapshot);
    expect(calls).toBe(1);
  });

  it("does not claim identity when a runtime image differs from the ledger", async () => {
    const reader = new ReleaseEvidenceReader({ target: "root@host.example", ...evidenceOptions, runner: async () => [
      record(currentSha, "current"),
      runtime("web", currentSha),
      runtime("mobile", previousSha),
    ].join("\n") });
    const snapshot = await reader.read();
    expect(snapshot.availability).toBe("ready");
    expect(snapshot.runtimeMatchesCurrent).toBe(false);
    expect(snapshot.rollbackCandidates).toEqual([]);
    expect(isVerifiedRollbackCandidate(snapshot, previousSha)).toBe(false);
  });

  it("allows only a healthy candidate when the current runtime exactly matches the ledger", async () => {
    const reader = new ReleaseEvidenceReader({ target: "root@host.example", ...evidenceOptions, runner: async () => [
      record(currentSha, "current"),
      record(previousSha, "candidate"),
      runtime("web", currentSha),
      runtime("mobile", currentSha),
    ].join("\n") });
    const snapshot = await reader.read();
    expect(isVerifiedRollbackCandidate(snapshot, previousSha)).toBe(true);
    expect(isVerifiedRollbackCandidate(snapshot, currentSha)).toBe(false);
  });

  it("returns a generic unavailable result for invalid SSH targets or ledger data", async () => {
    const invalidTarget = new ReleaseEvidenceReader({ target: "root@host.example;rm -rf /", runner: async () => "" });
    const invalidData = new ReleaseEvidenceReader({ target: "root@host.example", ...evidenceOptions, runner: async () => "private ssh error" });
    expect((await invalidTarget.read()).availability).toBe("unavailable");
    expect(await invalidData.read()).toMatchObject({
      availability: "unavailable",
      error: "Release ledger could not be read or validated.",
    });
  });
});
