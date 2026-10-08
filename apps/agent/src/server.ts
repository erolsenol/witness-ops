import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { createRunSchema, type CoolifySnapshot, type Project, type ReleaseAction, type ReleaseEvidenceSnapshot, type RunAction, type ToolAction } from "@deploy-relay/contracts";
import { inspectProject } from "@deploy-relay/core";
import { RunStore } from "./store.ts";
import { Scheduler } from "./scheduler.ts";
import { isVerifiedRollbackCandidate } from "./release-evidence.ts";
import { reportPath, type ReportKind } from "./tool-runner.ts";

export interface ServerDependencies {
  readonly projects: readonly Project[];
  readonly store: RunStore;
  readonly scheduler: Scheduler;
  readonly consoleDirectory?: string;
  readonly readCoolify?: () => Promise<CoolifySnapshot>;
  readonly readReleaseEvidence?: (projectId?: string) => Promise<ReleaseEvidenceSnapshot>;
  readonly authToken?: string;
}

function isToolAction(action: RunAction): action is ToolAction {
  return action === "deploy-verify" || action === "db-status" || action === "db-drill";
}

export async function createServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  server.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (host && !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) {
      return reply.code(403).send({ error: "Local host required." });
    }
    const origin = request.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(origin)) {
      return reply.code(403).send({ error: "Local origin required." });
    }
    if (request.url.startsWith("/api/") && dependencies.authToken && request.headers["x-witness-token"] !== dependencies.authToken) {
      return reply.code(401).send({ error: "Agent session token required." });
    }
    if (request.method !== "GET" && request.url.startsWith("/api/") && request.headers["x-witness-request"] !== "1") {
      return reply.code(403).send({ error: "Request header required." });
    }
  });

  server.get("/api/health", async () => ({ service: "witness-ops-agent", status: "ok" }));
  server.get("/api/projects", async () => dependencies.projects.map(inspectProject));
  server.get("/api/coolify", async () => dependencies.readCoolify?.() ?? {
    availability: "not_configured", checkedAt: new Date().toISOString(), applications: [], error: null,
  });
  server.get<{ Querystring: { projectId?: string } }>("/api/release-evidence", async (request, reply) => {
    const projectId = request.query.projectId;
    if (projectId && !dependencies.projects.some((project) => project.id === projectId)) {
      return reply.code(404).send({ error: "Unknown project." });
    }
    return dependencies.readReleaseEvidence?.(projectId) ?? {
      availability: "unavailable", checkedAt: new Date().toISOString(), current: null,
      rollbackCandidates: [], runtimeImages: [], runtimeMatchesCurrent: null,
      error: "Release ledger reader is not configured.",
    };
  });
  server.get("/api/runs", async () => dependencies.store.listRuns());
  server.get("/api/artifacts", async () => dependencies.store.listBuildArtifactSummaries());
  server.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = dependencies.store.getRun(request.params.id);
    return run ?? reply.code(404).send({ error: "Run not found." });
  });
  server.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", async (request, reply) => {
    if (!dependencies.store.getRun(request.params.id)) return reply.code(404).send({ error: "Run not found." });
    const after = Number(request.query.after ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) return reply.code(400).send({ error: "Invalid cursor." });
    return dependencies.store.listEvents(request.params.id, after);
  });
  server.get<{ Params: { id: string }; Querystring: { kind?: string } }>("/api/runs/:id/report", async (request, reply) => {
    if (!dependencies.store.getRun(request.params.id)) return reply.code(404).send({ error: "Run not found." });
    const kind = request.query.kind ?? "manual";
    if (!["manual", "deploy", "db"].includes(kind)) return reply.code(400).send({ error: "Invalid report kind." });
    const path = reportPath(request.params.id, kind as ReportKind);
    if (!existsSync(path)) return reply.code(404).send({ error: "Report not found." });
    return reply.type("application/json").send(readFileSync(path));
  });
  server.post("/api/runs", async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid run request." });
    if (parsed.data.action === "rollback") {
      const project = dependencies.projects.find((item) => item.id === parsed.data.projectId);
      if (!project) return reply.code(404).send({ error: "Unknown project." });
      if (!project.rollback) return reply.code(409).send({ error: "Rollback is not configured for this project." });
      const evidence = await dependencies.readReleaseEvidence?.(project.id);
      if (!evidence || !isVerifiedRollbackCandidate(evidence, parsed.data.expectedSha)) {
        return reply.code(409).send({ error: "Rollback requires a listed healthy candidate and matching current runtime images." });
      }
    }
    try {
      const run = isToolAction(parsed.data.action)
        ? dependencies.scheduler.enqueueTool(parsed.data.projectId, parsed.data.action)
        : parsed.data.action === "deploy"
        ? dependencies.scheduler.enqueue(parsed.data.projectId, "deploy", { sha: parsed.data.expectedSha, manifestHash: parsed.data.expectedManifestHash })
        : parsed.data.action === "rollback"
          ? dependencies.scheduler.enqueue(parsed.data.projectId, "rollback", { sha: parsed.data.expectedSha })
        : dependencies.scheduler.enqueue(parsed.data.projectId, parsed.data.action as ReleaseAction);
      return reply.code(202).send(run);
    } catch (error: unknown) {
      if (error instanceof Error && /^(Build is not configured|Deploy is not configured|Rollback is not configured|Verified build evidence|Deploy verification is not configured|Database recovery is not configured)/.test(error.message)) {
        return reply.code(409).send({ error: error.message });
      }
      return reply.code(404).send({ error: "Unknown project." });
    }
  });

  const directory = dependencies.consoleDirectory;
  if (directory && existsSync(join(directory, "index.html"))) {
    await server.register(fastifyStatic, { root: directory, prefix: "/" });
  } else {
    server.get("/", async () => ({ message: "Console not built. Run pnpm build." }));
  }

  return server;
}
