import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "./store.ts";
import { Scheduler } from "./scheduler.ts";
import { createServer } from "./server.ts";
import { CoolifyReader } from "./coolify.ts";
import { ReleaseEvidenceReader } from "./release-evidence.ts";
import { dataDirectory, loadCatalog } from "./config.ts";

const root = process.env.WITNESS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const authToken = process.env.WITNESS_AUTH_TOKEN ?? randomBytes(32).toString("hex");
const config = loadCatalog();
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const store = new RunStore(join(dataDirectory, "runs.sqlite"));
const scheduler = new Scheduler(config.projects, store);
const coolify = new CoolifyReader(process.env.COOLIFY_API_TOKEN, process.env.COOLIFY_API_BASE_URL ?? "");
const releaseReaders = new Map(config.projects.map((project) => [project.id, new ReleaseEvidenceReader(project.releaseEvidence ? {
  target: project.releaseEvidence.sshTarget,
  ledgerDirectory: project.releaseEvidence.ledgerDirectory,
  imagePrefix: project.releaseEvidence.imagePrefix,
  containers: project.releaseEvidence.containers,
} : {})]));
const legacyEvidenceProject = config.projects.filter((project) => project.rollback).length === 1
  ? config.projects.find((project) => project.rollback)?.id : undefined;
const server = await createServer({
  projects: config.projects,
  store,
  scheduler,
  readCoolify: () => coolify.read(config.projects),
  readReleaseEvidence: (projectId, fresh) => {
    const selected = projectId ?? legacyEvidenceProject;
    const project = config.projects.find((item) => item.id === selected);
    if (!project || (!project.releaseEvidence && project.id !== legacyEvidenceProject)) {
      return new ReleaseEvidenceReader({ target: "" }).read();
    }
    return releaseReaders.get(project.id)!.read({ fresh: fresh === true });
  },
  consoleDirectory: join(root, "apps", "console", "dist"),
  authToken,
});
const port = Number(process.env.WITNESS_PORT ?? "3847");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local port.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close()
      .then(() => scheduler.idle())
      .finally(() => { store.close(); process.exit(0); });
  });
}

await server.listen({ host: "127.0.0.1", port });
process.stdout.write(`WitnessOps console: http://127.0.0.1:${port}/#token=${authToken}\n`);
