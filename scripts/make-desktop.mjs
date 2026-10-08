import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagedAgent = join(root, "apps", "desktop", "build", "agent");
const stagedDesktop = join(root, "apps", "desktop", "build", "standalone");
const releaseOutput = join(root, "apps", "desktop", "out", "make");

function run(args) {
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed (${result.status ?? result.error?.message}).`);
  }
}

function runIconBuild() {
  const iconBuilder = spawnSync("swift", [
    join(root, "scripts", "build-macos-icon.swift"),
    join(root, "apps", "console", "public", "brand", "witnessops-mark.svg"),
    join(root, "apps", "desktop", "assets", "witnessops.icns"),
  ], { cwd: root, stdio: "inherit" });
  if (iconBuilder.error || iconBuilder.status !== 0) {
    throw new Error(`macOS icon generation failed (${iconBuilder.status ?? iconBuilder.error?.message}).`);
  }
}

run(["build"]);
rmSync(stagedAgent, { recursive: true, force: true });
run(["--filter", "@erol.senol/witness-ops", "deploy", "--prod", stagedAgent]);
cpSync(join(root, ".node-version"), join(stagedAgent, ".node-version"));
mkdirSync(join(stagedAgent, "bin"), { recursive: true });
cpSync(process.execPath, join(stagedAgent, "bin", "node"));
runIconBuild();
rmSync(stagedDesktop, { recursive: true, force: true });
run(["--filter", "@deploy-relay/desktop", "deploy", "--node-linker", "hoisted", stagedDesktop]);
rmSync(join(stagedDesktop, "out"), { recursive: true, force: true });
cpSync(stagedAgent, join(stagedDesktop, "build", "agent"), { recursive: true, force: true });
const forge = spawnSync(process.execPath, [
  "node_modules/@electron-forge/cli/dist/electron-forge.js",
  "make", "--platform", "darwin", "--arch", "arm64",
], {
  cwd: stagedDesktop,
  stdio: "inherit",
  env: { ...process.env, PNPM_CONFIG_NODE_LINKER: "hoisted" },
});
if (forge.error || forge.status !== 0) {
  throw new Error(`Electron packaging failed (${forge.status ?? forge.error?.message}).`);
}
rmSync(releaseOutput, { recursive: true, force: true });
cpSync(join(stagedDesktop, "out", "make"), releaseOutput, { recursive: true });
