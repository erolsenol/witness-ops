import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "./store.ts";
import { Scheduler } from "./scheduler.ts";
import { createServer } from "./server.ts";
import { CoolifyReader } from "./coolify.ts";
import { ReleaseEvidenceReader } from "./release-evidence.ts";
import { dataDirectory, loadCatalog } from "./config.ts";

const root = process.env.WITNESS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const config = loadCatalog();
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const store = new RunStore(join(dataDirectory, "runs.sqlite"));
const scheduler = new Scheduler(config.projects, store);
const coolify = new CoolifyReader(process.env.COOLIFY_API_TOKEN, process.env.COOLIFY_API_BASE_URL ?? "");
const releaseEvidence = new ReleaseEvidenceReader();
const server = await createServer({
  projects: config.projects,
  store,
  scheduler,
  readCoolify: () => coolify.read(config.projects),
  readReleaseEvidence: () => releaseEvidence.read(),
  consoleDirectory: join(root, "apps", "console", "dist"),
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
process.stdout.write(`WitnessOps agent listening on http://127.0.0.1:${port}\n`);
