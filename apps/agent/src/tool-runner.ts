import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "@witness-ops/contracts";
import { dataDirectory } from "./config.ts";

const root = process.env.WITNESS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const reportDirectory = join(dataDirectory, "reports");

export type ReportKind = "manual" | "deploy" | "db";

export function reportPath(runId: string, kind: ReportKind = "manual"): string {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("Invalid run ID.");
  return join(reportDirectory, `${runId}-${kind}.json`);
}

async function invoke(entry: string, args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 2 * 60 * 60 * 1000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Verification tool could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (stdout.length > 4 * 1024 * 1024) reject(new Error("Verification output exceeded the size limit."));
      else resolvePromise({ code: code ?? 1, stdout });
    });
  });
}

export async function runDeployVerification(
  project: Project,
  sha: string,
  runId: string,
  kind: ReportKind = "manual",
  startedAfter?: string,
): Promise<string> {
  const config = project.deployVerification;
  if (!config) throw new Error("Deploy verification is not configured.");
  const path = reportPath(runId, kind);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const args = [
    "verify", "--config", config.configPath, "--expected-sha", sha, "--report", path,
    ...(startedAfter ? ["--started-after", startedAfter] : []),
  ];
  const result = await invoke(join(root, "packages", "deploy-witness", "dist", "cli.js"), args, project.root);
  if (result.code !== 0) throw new Error(`Deploy verification did not pass (exit ${result.code}).`);
  if (!existsSync(path)) throw new Error("Deploy verification did not write an evidence report.");
  return path;
}

export async function runDatabaseCheck(
  project: Project,
  action: "status" | "drill",
  runId: string,
  kind: ReportKind = "manual",
): Promise<string> {
  const config = project.databaseRecovery;
  if (!config) throw new Error("Database recovery is not configured.");
  const result = await invoke(
    join(root, "packages", "restore-witness", "dist", "cli.js"),
    [action, config.projectId, "--config", config.configPath],
    project.root,
  );
  const path = reportPath(runId, kind);
  if (result.stdout.trim()) {
    const parsed: unknown = JSON.parse(result.stdout);
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  if (result.code !== 0) throw new Error(`Database ${action} did not pass (exit ${result.code}).`);
  if (!existsSync(path)) throw new Error("Database check did not write an evidence report.");
  return path;
}
