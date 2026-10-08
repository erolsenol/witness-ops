import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Project, ReleaseAction, RunRecord, ToolAction } from "@deploy-relay/contracts";
import { buildProject, checkProject, deployProject, executeLockedStep, inspectProject, projectNodeVersion, rollbackProject } from "@deploy-relay/core";
import { RunStore } from "./store.ts";
import { reportPath, runDatabaseCheck, runDeployVerification } from "./tool-runner.ts";

export class Scheduler {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly projects: readonly Project[],
    private readonly store: RunStore,
    private readonly executeStep = executeLockedStep,
  ) {}

  enqueue(projectId: string, action: ReleaseAction, expected?: { readonly sha: string; readonly manifestHash?: string }): RunRecord {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (action === "build" && !project.build) throw new Error(`Build is not configured for ${projectId}.`);
    if (action === "rollback" && (!project.rollback || !expected?.sha)) throw new Error(`Rollback is not configured for ${projectId}.`);
    if (action === "deploy") {
      if (!project.deploy || !project.build) throw new Error(`Deploy is not configured for ${projectId}.`);
      const artifact = this.store.getBuildArtifact(projectId);
      if (!artifact || artifact.sha !== expected?.sha || artifact.manifestHash !== expected.manifestHash) {
        throw new Error("Verified build evidence does not match the requested deploy.");
      }
    }
    const run = this.store.createRun(randomUUID(), projectId, action);
    const actionName = action === "plan" ? "plan" : action === "check" ? "kontrol" : action === "build" ? "paket oluşturma" : action === "deploy" ? "üretime gönderme" : "geri alma";
    this.store.appendEvent(run.id, "info", `${project.name}: ${actionName} sıraya alındı.`);
    this.#tail = this.#tail.then(() => this.execute(run.id, project, action, expected)).catch(() => undefined);
    return run;
  }

  enqueueTool(projectId: string, action: ToolAction): RunRecord {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (action === "deploy-verify" && !project.deployVerification) throw new Error("Deploy verification is not configured.");
    if (action !== "deploy-verify" && !project.databaseRecovery) throw new Error("Database recovery is not configured.");
    const run = this.store.createRun(randomUUID(), projectId, action);
    this.store.appendEvent(run.id, "info", `${project.name}: ${action} queued.`);
    this.#tail = this.#tail.then(() => this.executeTool(run.id, project, action)).catch(() => undefined);
    return run;
  }

  async idle(): Promise<void> { await this.#tail; }

  private async executeTool(id: string, project: Project, action: ToolAction): Promise<void> {
    this.store.setStatus(id, "running");
    try {
      const source = inspectProject(project);
      if (action === "deploy-verify") {
        if (source.error || !source.sha || !source.clean) throw new Error("A clean source commit is required.");
        this.store.setStatus(id, "running", { sha: source.sha, ...(source.branch ? { branch: source.branch } : {}) });
        await runDeployVerification(project, source.sha, id);
      } else {
        await runDatabaseCheck(project, action === "db-drill" ? "drill" : "status", id);
      }
      this.store.appendEvent(id, "result", "Verification passed. Open the evidence report for details.");
      this.store.setStatus(id, "passed");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Verification failed.";
      this.store.setStatus(id, "failed", { error: message });
      this.store.appendEvent(id, "error", message);
    }
    if (existsSync(reportPath(id))) this.store.appendEvent(id, "result", "Evidence report is available.");
  }

  private async execute(id: string, project: Project, action: ReleaseAction, expected?: { readonly sha: string; readonly manifestHash?: string }): Promise<void> {
    this.store.setStatus(id, "running");
    let deploymentStarted = false;
    let deploymentStartedAt: string | undefined;
    try {
      const initial = inspectProject(project);
      if (initial.error || !initial.sha) throw new Error(initial.error ?? "Source SHA unavailable.");
      this.store.setStatus(id, "running", {
        sha: initial.sha,
        ...(initial.branch ? { branch: initial.branch } : {}),
      });
      if (action === "plan") {
        this.store.appendEvent(id, "info", `Kaynak ${initial.sha.slice(0, 12)}; dal ${initial.branch ?? "bilinmiyor"}; ${initial.clean ? "temiz" : "değişiklik var"}.`);
        for (const step of project.checks) this.store.appendEvent(id, "step", `Çalışacak kontrol: ${step.label}`);
        if (project.build) this.store.appendEvent(id, "info", `Paket adımı: ${project.build.label}; yalnızca temiz ${project.productionBranch} dalında.`);
        if (project.deploy) this.store.appendEvent(id, "info", `Üretim adımı: ${project.deploy.label}; doğrulanmış paket ve açık onay gerekir.`);
      } else if (action === "build") {
        const result = await buildProject(project, {
          inspect: inspectProject,
          nodeVersion: projectNodeVersion(project),
          executeStep: this.executeStep,
          onStep: (message) => this.store.appendEvent(id, "step", message),
        });
        this.store.saveBuildArtifact({ projectId: project.id, ...result, runId: id, createdAt: new Date().toISOString() });
        this.store.appendEvent(id, "result", `Manifest SHA-256: ${result.manifestHash}`);
      } else if (action === "deploy") {
        const artifact = this.store.getBuildArtifact(project.id);
        if (!artifact || artifact.sha !== expected?.sha || artifact.manifestHash !== expected.manifestHash) {
          throw new Error("Verified build evidence changed while deploy was queued.");
        }
        if (project.databaseRecovery?.beforeDeploy) {
          this.store.appendEvent(id, "step", "Database recovery drill started.");
          await runDatabaseCheck(project, "drill", id, "db");
          this.store.appendEvent(id, "result", "Database recovery drill passed.");
        }
        await deployProject(project, artifact, {
          inspect: inspectProject,
          nodeVersion: projectNodeVersion(project),
          executeStep: this.executeStep,
          onStep: (message) => this.store.appendEvent(id, "step", message),
        }, () => { deploymentStarted = true; deploymentStartedAt = new Date().toISOString(); });
        this.store.appendEvent(id, "result", "Native receiver ve açık SHA smoke geçti; uzak ledger ve çalışan imaj kimliğini ayrıca inceleyin.");
        if (project.deployVerification) {
          this.store.appendEvent(id, "step", "Independent deployment verification started.");
          await runDeployVerification(project, artifact.sha, id, "deploy", deploymentStartedAt);
          this.store.appendEvent(id, "result", "Independent deployment verification passed.");
        }
      } else if (action === "rollback") {
        if (!expected?.sha) throw new Error("A previous healthy release SHA is required.");
        await rollbackProject(project, expected.sha, {
          inspect: inspectProject,
          nodeVersion: projectNodeVersion(project),
          executeStep: this.executeStep,
          onStep: (message) => this.store.appendEvent(id, "step", message),
        }, () => { deploymentStarted = true; });
        this.store.appendEvent(id, "result", `Native rollback ve hedef SHA smoke geçti: ${expected.sha.slice(0, 12)}.`);
      } else {
        await checkProject(project, {
          inspect: inspectProject,
          nodeVersion: projectNodeVersion(project),
          executeStep: this.executeStep,
          onStep: (message) => this.store.appendEvent(id, "step", message),
        });
      }
      this.store.setStatus(id, "passed");
      this.store.appendEvent(id, "result", `${action === "plan" ? "Plan" : action === "check" ? "Kontroller" : action === "build" ? "Paket doğrulaması" : "Native dağıtım ve smoke"} tamamlandı: ${initial.sha.slice(0, 12)}.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown failure";
      this.store.setStatus(id, deploymentStarted ? "needs_attention" : "failed", { error: message });
      this.store.appendEvent(id, "error", message);
    }
    for (const kind of ["db", "deploy"] as const) {
      if (existsSync(reportPath(id, kind))) this.store.appendEvent(id, "result", `${kind} evidence report is available.`);
    }
  }
}
