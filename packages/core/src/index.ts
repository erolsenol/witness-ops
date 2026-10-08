import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Project, ProjectState } from "@witness-ops/contracts";

const devRun = process.env.WITNESS_DEV_RUN ?? join(homedir(), ".local", "bin", "dev-run");

export function projectNodeVersion(project: Project): string {
  const result = spawnSync("node", ["-p", "process.versions.node"], {
    cwd: project.root,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Cannot resolve Node for ${project.name}.`);
  return result.stdout.trim();
}

function git(project: Project, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", project.root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect ${project.name} repository.`);
  }
  return result.stdout.trim();
}

export function inspectProject(project: Project): ProjectState {
  try {
    return {
      id: project.id,
      name: project.name,
      branch: git(project, ["branch", "--show-current"]),
      sha: git(project, ["rev-parse", "HEAD"]),
      clean: git(project, ["status", "--porcelain"]) === "",
      error: null,
      productionBranch: project.productionBranch,
      coolifyApplications: project.coolifyApplications,
      buildAvailable: Boolean(project.build),
      deployAvailable: Boolean(project.deploy),
      rollbackAvailable: Boolean(project.rollback),
      deployVerificationAvailable: Boolean(project.deployVerification),
      databaseRecoveryAvailable: Boolean(project.databaseRecovery),
    };
  } catch (error: unknown) {
    return {
      id: project.id,
      name: project.name,
      branch: null,
      sha: null,
      clean: null,
      error: error instanceof Error ? error.message : "Repository inspection failed.",
      productionBranch: project.productionBranch,
      coolifyApplications: project.coolifyApplications,
      buildAvailable: Boolean(project.build),
      deployAvailable: Boolean(project.deploy),
      rollbackAvailable: Boolean(project.rollback),
      deployVerificationAvailable: Boolean(project.deployVerification),
      databaseRecoveryAvailable: Boolean(project.databaseRecovery),
    };
  }
}

export interface CheckOptions {
  readonly executeStep: (project: Project, command: string, args: readonly string[]) => Promise<void>;
  readonly inspect: (project: Project) => ProjectState;
  readonly onStep: (message: string) => void;
  readonly nodeVersion: string;
}

export async function checkProject(project: Project, options: CheckOptions): Promise<string> {
  const before = options.inspect(project);
  if (before.error || !before.sha || !before.branch) throw new Error(before.error ?? "Repository identity is unavailable.");
  if (!before.clean) throw new Error("Working tree is dirty; check evidence cannot be tied to a commit.");
  if (options.nodeVersion !== project.nodeVersion) {
    throw new Error(`Node ${project.nodeVersion} required; current ${options.nodeVersion}.`);
  }

  for (const step of project.checks) {
    options.onStep(`${step.label} started`);
    await options.executeStep(project, step.command, step.args);
    options.onStep(`${step.label} passed`);
  }

  const after = options.inspect(project);
  if (after.sha !== before.sha || after.branch !== before.branch || !after.clean) {
    throw new Error("Source changed during checks; result is invalid.");
  }
  return before.sha;
}

export async function buildProject(project: Project, options: CheckOptions): Promise<{ readonly sha: string; readonly manifest: string; readonly manifestHash: string }> {
  const build = project.build;
  if (!build) throw new Error("Build is not configured for this project.");
  const state = options.inspect(project);
  if (state.branch !== project.productionBranch) {
    throw new Error(`Build requires the ${project.productionBranch} branch.`);
  }
  const sha = await checkProject(project, options);
  options.onStep(`${build.label} started`);
  await options.executeStep(project, build.command, build.args);

  const after = options.inspect(project);
  if (after.sha !== sha || !after.clean || after.branch !== project.productionBranch) {
    throw new Error("Source changed during build; artifact is invalid.");
  }
  const manifest = resolve(project.root, build.manifest.replace("{sha}", sha));
  if (!manifest.startsWith(`${resolve(project.root)}${sep}`) || !existsSync(manifest)) {
    throw new Error("Expected release manifest is missing or outside the repository.");
  }
  const realRoot = realpathSync(project.root);
  const realManifest = realpathSync(manifest);
  if (!realManifest.startsWith(`${realRoot}${sep}`) || !statSync(realManifest).isFile()) {
    throw new Error("Expected release manifest is not a regular file inside the repository.");
  }
  options.onStep(`${build.label} passed`);
  options.onStep(`${build.verify.label} started`);
  const verifyArgs = build.verify.args.map((arg) => arg.replace("{manifest}", manifest));
  await options.executeStep(project, build.verify.command, verifyArgs);
  const verified = options.inspect(project);
  if (verified.sha !== sha || !verified.clean || verified.branch !== project.productionBranch) {
    throw new Error("Source changed during bundle verification; artifact is invalid.");
  }
  options.onStep(`${build.verify.label} passed`);
  return { sha, manifest, manifestHash: createHash("sha256").update(readFileSync(manifest)).digest("hex") };
}

export interface DeployEvidence {
  readonly sha: string;
  readonly manifest: string;
  readonly manifestHash: string;
}

export async function deployProject(project: Project, evidence: DeployEvidence, options: CheckOptions, onDeploymentStarted: () => void): Promise<void> {
  const build = project.build;
  const deploy = project.deploy;
  if (!build || !deploy) throw new Error("Deploy is not configured for this project.");
  const source = options.inspect(project);
  if (source.error || source.sha !== evidence.sha || !source.clean || source.branch !== project.productionBranch) {
    throw new Error("Deploy requires the same clean production-branch SHA as the verified build.");
  }
  if (options.nodeVersion !== project.nodeVersion) throw new Error(`Node ${project.nodeVersion} required; current ${options.nodeVersion}.`);
  const expectedManifest = resolve(project.root, build.manifest.replace("{sha}", evidence.sha));
  if (evidence.manifest !== expectedManifest || !existsSync(expectedManifest)) throw new Error("Verified build manifest is missing or changed.");
  const realRoot = realpathSync(project.root);
  const realManifest = realpathSync(expectedManifest);
  if (!realManifest.startsWith(`${realRoot}${sep}`) || !statSync(realManifest).isFile()) {
    throw new Error("Verified build manifest is outside the repository.");
  }
  const hash = () => createHash("sha256").update(readFileSync(expectedManifest)).digest("hex");
  if (hash() !== evidence.manifestHash) throw new Error("Build manifest checksum changed.");
  options.onStep(`${build.verify.label} started`);
  await options.executeStep(project, build.verify.command, build.verify.args.map((arg) => arg.replace("{manifest}", expectedManifest)));
  options.onStep(`${build.verify.label} passed`);
  const beforeDeploy = options.inspect(project);
  if (beforeDeploy.sha !== evidence.sha || !beforeDeploy.clean || beforeDeploy.branch !== project.productionBranch || hash() !== evidence.manifestHash) {
    throw new Error("Source or manifest changed before deploy.");
  }
  options.onStep(`${deploy.label} started`);
  onDeploymentStarted();
  await options.executeStep(project, deploy.command, deploy.args.map((arg) => arg.replace("{manifest}", expectedManifest)));
  options.onStep(`${deploy.label} finished`);
  options.onStep(`${deploy.smoke.label} started`);
  await options.executeStep(project, deploy.smoke.command, deploy.smoke.args.map((arg) => arg.replace("{sha}", evidence.sha)));
  options.onStep(`${deploy.smoke.label} passed`);
  const after = options.inspect(project);
  if (after.sha !== evidence.sha || !after.clean || after.branch !== project.productionBranch || hash() !== evidence.manifestHash) {
    throw new Error("Source or manifest changed during deploy; inspect remote state.");
  }
}

export async function rollbackProject(project: Project, targetSha: string, options: CheckOptions, onRollbackStarted: () => void): Promise<void> {
  const rollback = project.rollback;
  if (!rollback) throw new Error("Rollback is not configured for this project.");
  if (!/^[a-f0-9]{40}$/.test(targetSha)) throw new Error("Rollback target must be a full commit SHA.");
  const source = options.inspect(project);
  if (source.error || !source.sha || !source.branch) throw new Error(source.error ?? "Source identity is unavailable.");
  if (!source.clean || source.branch !== project.productionBranch) {
    throw new Error(`Rollback requires a clean ${project.productionBranch} checkout.`);
  }
  if (options.nodeVersion !== project.nodeVersion) throw new Error(`Node ${project.nodeVersion} required; current ${options.nodeVersion}.`);

  options.onStep(`${rollback.label} started for ${targetSha.slice(0, 12)}`);
  onRollbackStarted();
  await options.executeStep(project, rollback.command, rollback.args.map((arg) => arg.replaceAll("{sha}", targetSha)));
  options.onStep(`${rollback.label} receiver finished`);
  options.onStep(`${rollback.smoke.label} started`);
  await options.executeStep(project, rollback.smoke.command, rollback.smoke.args.map((arg) => arg.replaceAll("{sha}", targetSha)));
  options.onStep(`${rollback.smoke.label} passed`);
  const after = options.inspect(project);
  if (after.sha !== source.sha || after.branch !== project.productionBranch || !after.clean) {
    throw new Error("Source changed during rollback; inspect the remote state.");
  }
}

export async function executeLockedStep(project: Project, command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let diagnostic = "";
    const readSafeLines = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending = `${pending}${chunk}`.slice(-8192);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const safe = safeStepDiagnostic(line);
          if (safe) diagnostic = safe;
        }
      });
    };
    const child = spawn(existsSync(devRun) ? devRun : command, existsSync(devRun) ? ["--wait", "--", command, ...args] : [...args], {
      cwd: project.root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    readSafeLines(child.stdout);
    readSafeLines(child.stderr);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 2 * 60 * 60 * 1000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} failed (${code ?? signal})${diagnostic ? `: ${diagnostic}` : "."}`));
    });
  });
}

export function safeStepDiagnostic(line: string): string | null {
  if (/^Running production dependency security audit\.\.\.$/.test(line)) return "Production dependency security audit";
  const audit = /^(\d{1,5}) vulnerabilities? \((\d{1,5}) moderate, (\d{1,5}) high, (\d{1,5}) critical\)$/.exec(line.trim());
  return audit ? `${audit[1]} vulnerabilities (${audit[2]} moderate, ${audit[3]} high, ${audit[4]} critical)` : null;
}
