import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspectProject } from "@deploy-relay/core";
import { parseCliArgs } from "./cli-args.ts";
import { Scheduler } from "./scheduler.ts";
import { RunStore } from "./store.ts";
import { ReleaseEvidenceReader, isVerifiedRollbackCandidate } from "./release-evidence.ts";
import { dataDirectory, loadCatalog } from "./config.ts";

const config = loadCatalog();
const request = parseCliArgs(process.argv.slice(2), config.projects);
const selected = request.projectIds.map((id) => config.projects.find((project) => project.id === id)!);

if (request.dryRun) {
  const plans = selected.map((project) => ({
    projectId: project.id,
    source: inspectProject(project),
    action: request.action,
    steps: [
      ...project.checks.map((step) => step.label),
      ...(request.action === "build" && project.build ? [project.build.label, project.build.verify.label] : []),
      ...(request.action === "deploy" && project.deploy ? [project.deploy.label, project.deploy.smoke.label, ...(project.deployVerification ? ["Independent deployment verification"] : [])] : []),
      ...(request.action === "rollback" && project.rollback ? [`${project.rollback.label} -> ${request.expectedSha}`, project.rollback.smoke.label] : []),
    ],
  }));
  process.stdout.write(`${JSON.stringify(plans, null, 2)}\n`);
} else {
  if (request.action === "rollback" && request.expectedSha) {
    const project = selected[0]!;
    const evidence = await new ReleaseEvidenceReader(project.releaseEvidence ? {
      target: project.releaseEvidence.sshTarget,
      ledgerDirectory: project.releaseEvidence.ledgerDirectory,
      imagePrefix: project.releaseEvidence.imagePrefix,
      containers: project.releaseEvidence.containers,
    } : {}).read();
    if (!isVerifiedRollbackCandidate(evidence, request.expectedSha)) {
      throw new Error("Rollback requires a listed healthy candidate and matching current runtime images.");
    }
  }
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new RunStore(join(dataDirectory, "runs.sqlite"));
  const scheduler = new Scheduler(config.projects, store);
  try {
    for (const project of selected) {
      const run = scheduler.enqueue(project.id, request.action, request.expectedSha ? { sha: request.expectedSha, ...(request.expectedManifestHash ? { manifestHash: request.expectedManifestHash } : {}) } : undefined);
      await scheduler.idle();
      const result = store.getRun(run.id);
      process.stdout.write(`${project.id}: ${result?.status ?? "missing"} (${result?.sourceSha?.slice(0, 12) ?? "no-sha"})\n`);
      for (const event of store.listEvents(run.id)) process.stdout.write(`  ${event.kind}: ${event.message}\n`);
      if (result?.status !== "passed") {
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    store.close();
  }
}
