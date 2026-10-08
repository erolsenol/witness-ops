#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [group, ...args] = process.argv.slice(2);

if (group === "--version" || group === "-V") {
  process.stdout.write(`${manifest.version}\n`);
} else if (!group || group === "--help" || group === "-h") {
  process.stdout.write(`WitnessOps ${manifest.version}

Usage:
  witness release <plan|check|build|deploy|rollback> [options]
  witness deploy <verify|report|config|init|schema> [options]
  witness db <backup|verify|drill|restore|monitor|status|list|...> [options]
  witness app
`);
} else {
  const targets = {
    release: join(root, "apps", "agent", "dist", "cli.js"),
    deploy: join(root, "packages", "deploy-witness", "dist", "cli.js"),
    db: join(root, "packages", "restore-witness", "dist", "cli.js"),
    app: join(root, "apps", "agent", "dist", "index.js"),
  };
  const target = targets[group];
  if (!target || (group === "app" && args.length > 0)) {
    process.stderr.write("Unknown command. Run witness --help.\n");
    process.exitCode = 2;
  } else if ((group === "release" || group === "app") && process.platform !== "darwin") {
    process.stderr.write("Release control and the local app require macOS.\n");
    process.exitCode = 2;
  } else {
    const child = spawn(process.execPath, [target, ...args], {
      stdio: "inherit",
      env: { ...process.env, WITNESS_ROOT: root, WITNESS_OPS_CLI_GROUP: group },
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => child.kill(signal));
    }
    child.once("error", (error) => {
      process.stderr.write(`Could not start ${group}: ${error.message}\n`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
