import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function formatDoctorReport(checks) {
  return checks.map(({ status, label, detail }) => {
    const icon = status === "ok" ? "✓" : status === "warning" ? "!" : "✗";
    return `${icon} ${label}: ${detail}`;
  }).join("\n");
}

function canAccess(path, mode) {
  try { accessSync(path, mode); return true; } catch { return false; }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function collectDoctorChecks({ root, platform, nodeVersion, pnpmVersion, xcodePath, projects, devRunPath, lockPath }) {
  const checks = [];
  checks.push({
    status: platform === "darwin" ? "ok" : "error",
    label: "Platform",
    detail: platform === "darwin" ? "macOS" : "WitnessOps desktop currently requires macOS",
  });
  const expectedNode = readFileSync(join(root, ".node-version"), "utf8").trim();
  checks.push({
    status: nodeVersion === `v${expectedNode}` ? "ok" : "error",
    label: "Node.js",
    detail: nodeVersion === `v${expectedNode}` ? nodeVersion : `requires v${expectedNode}; found ${nodeVersion}`,
  });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedPnpm = manifest.packageManager?.replace(/^pnpm@/, "");
  checks.push({
    status: pnpmVersion === expectedPnpm ? "ok" : "error",
    label: "pnpm",
    detail: pnpmVersion === expectedPnpm ? pnpmVersion : `requires ${expectedPnpm}; found ${pnpmVersion ?? "unavailable"}`,
  });
  checks.push({
    status: xcodePath ? "ok" : "error",
    label: "Xcode command line tools",
    detail: xcodePath ?? "not available (install with xcode-select --install)",
  });
  for (const project of projects) {
    const projectGitRoot = existsSync(project.root) ? commandOutput("git", ["-C", project.root, "rev-parse", "--show-toplevel"]) : null;
    checks.push({
      status: projectGitRoot !== null ? "ok" : "warning",
      label: `Project ${project.id}`,
      detail: projectGitRoot !== null ? "checkout available" : "checkout unavailable; its actions cannot run",
    });
  }
  const devRunAvailable = canAccess(devRunPath, constants.X_OK);
  checks.push({ status: devRunAvailable ? "ok" : "error", label: "Shared command runner", detail: devRunAvailable ? "dev-run executable" : "dev-run is missing or not executable" });
  const lockAvailable = existsSync(lockPath) ? canAccess(lockPath, constants.W_OK) : canAccess(dirname(lockPath), constants.W_OK | constants.X_OK);
  checks.push({ status: lockAvailable ? "ok" : "error", label: "Shared command lock", detail: lockAvailable ? "writable" : "not writable; checks and builds cannot start" });
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configuredPath = process.env.WITNESS_CONFIG ?? join(root, "config", "projects.json");
  const configPath = existsSync(configuredPath) ? configuredPath : join(root, "config", "projects.example.json");
  const devRunPath = process.env.WITNESS_DEV_RUN ?? "/Users/erolsenol/.local/bin/dev-run";
  const lockPath = join(homedir(), ".local", "share", "dev-environment", "heavy-command.lock");
  try {
    const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    if (!Array.isArray(rawConfig.projects)) throw new Error("projects must be an array");
    const checks = collectDoctorChecks({ root, platform: process.platform, nodeVersion: process.version, pnpmVersion: commandOutput("pnpm", ["--version"]), xcodePath: commandOutput("xcode-select", ["-p"]), projects: rawConfig.projects, devRunPath, lockPath });
    process.stdout.write(`WitnessOps readiness\n${formatDoctorReport(checks)}\n`);
    if (checks.some((check) => check.status === "error")) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`WitnessOps readiness check failed: ${error instanceof Error ? error.message : "invalid configuration"}\n`);
    process.exitCode = 1;
  }
}
