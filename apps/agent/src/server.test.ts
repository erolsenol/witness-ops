import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./server.ts";
import { RunStore } from "./store.ts";
import { Scheduler } from "./scheduler.ts";
import type { FastifyInstance } from "fastify";
import type { Project, ReleaseEvidenceSnapshot } from "@deploy-relay/contracts";

const servers: FastifyInstance[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const store of stores.splice(0)) store.close();
});

async function setup(projects: readonly Project[] = [], readReleaseEvidence?: () => Promise<ReleaseEvidenceSnapshot>): Promise<FastifyInstance> {
  const store = new RunStore(":memory:");
  stores.push(store);
  const server = await createServer({
    projects,
    store,
    scheduler: new Scheduler(projects, store),
    ...(readReleaseEvidence ? { readReleaseEvidence } : {}),
  });
  servers.push(server);
  return server;
}

describe("local API boundary", () => {
  it("serves health and rejects a foreign browser origin", async () => {
    const server = await setup();
    const health = await server.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:3847" } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ service: "witness-ops-agent" });
    const denied = await server.inject({
      method: "POST", url: "/api/runs",
      headers: { host: "127.0.0.1:3847", origin: "https://other.example", "x-witness-request": "1" },
      payload: { projectId: "guven", action: "plan" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("requires a write header and rejects unknown projects", async () => {
    const server = await setup();
    const withoutHeader = await server.inject({
      method: "POST", url: "/api/runs", payload: { projectId: "guven", action: "plan" },
    });
    expect(withoutHeader.statusCode).toBe(403);
    const unknown = await server.inject({
      method: "POST", url: "/api/runs",
      headers: { "x-witness-request": "1" },
      payload: { projectId: "missing", action: "plan" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("rejects build for a project without a configured build command", async () => {
    const project: Project = {
      id: "example", name: "Example", root: "/tmp/example", productionBranch: "main",
      nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: [],
      checks: [{ label: "Check", command: "npm", args: ["test"] }],
    };
    const server = await setup([project]);
    const response = await server.inject({
      method: "POST", url: "/api/runs", headers: { "x-witness-request": "1" },
      payload: { projectId: "example", action: "build" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("not configured") });
  });

  it("requires exact verified evidence for a deploy request", async () => {
    const project: Project = {
      id: "example", name: "Example", root: "/tmp/example", productionBranch: "main",
      nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: [],
      checks: [{ label: "Check", command: "npm", args: ["test"] }],
      build: { label: "Build", command: "npm", args: ["run", "build"], manifest: ".release-artifacts/{sha}/manifest.json", verify: { label: "Verify", command: "npm", args: ["run", "verify", "{manifest}"] } },
      deploy: { label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"], smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] } },
    };
    const server = await setup([project]);
    const response = await server.inject({
      method: "POST", url: "/api/runs", headers: { "x-witness-request": "1" },
      payload: { projectId: "example", action: "deploy", expectedSha: "a".repeat(40), expectedManifestHash: "b".repeat(64) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("does not match") });
  });

  it("rejects a rollback request when the project has no native rollback adapter", async () => {
    const project: Project = {
      id: "example", name: "Example", root: "/tmp/example", productionBranch: "main",
      nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: [],
      checks: [{ label: "Check", command: "npm", args: ["test"] }],
    };
    const server = await setup([project]);
    const response = await server.inject({
      method: "POST", url: "/api/runs", headers: { "x-witness-request": "1" },
      payload: { projectId: "example", action: "rollback", expectedSha: "a".repeat(40) },
    });
    expect(response.statusCode).toBe(409);
  });

  it("exposes only a generic unavailable release-evidence result when not configured", async () => {
    const server = await setup();
    const response = await server.inject({ method: "GET", url: "/api/release-evidence" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      availability: "unavailable", current: null, rollbackCandidates: [],
      runtimeImages: [], runtimeMatchesCurrent: null,
    });
  });

  it("blocks rollback unless current runtime image IDs match the ledger", async () => {
    const project: Project = {
      id: "guven", name: "Guven", root: "/tmp/guven", productionBranch: "main",
      nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: [],
      checks: [{ label: "Check", command: "npm", args: ["test"] }],
      rollback: {
        label: "Rollback", command: "npm", args: ["run", "rollback", "guven-{sha}"],
        smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
      },
    };
    const readReleaseEvidence = async (): Promise<ReleaseEvidenceSnapshot> => ({
      availability: "ready", checkedAt: "2026-10-08T00:00:00.000Z", current: null,
      rollbackCandidates: [], runtimeImages: [], runtimeMatchesCurrent: false, error: null,
    });
    const server = await setup([project], readReleaseEvidence);
    const response = await server.inject({
      method: "POST", url: "/api/runs", headers: { "x-witness-request": "1" },
      payload: { projectId: "guven", action: "rollback", expectedSha: "a".repeat(40) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("matching current runtime images") });
  });
});
