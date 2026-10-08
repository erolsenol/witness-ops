import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const sha = "a".repeat(40);
const directory = await mkdtemp(join(tmpdir(), "witness-action-smoke-"));
const configPath = join(directory, "action-consumer.json");
const reportPath = join(directory, "report.json");
const fixture = spawn(process.execPath, [join(root, "scripts", "action-consumer-fixture.mjs"), directory, sha], {
  cwd: root,
  stdio: "ignore",
});

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(configPath);
      break;
    } catch {
      if (fixture.exitCode !== null) throw new Error("Action fixture exited early.");
      await delay(100);
    }
  }
  await stat(configPath);
  await writeFile(join(directory, "output"), "");
  await writeFile(join(directory, "summary"), "");
  const action = spawn(process.execPath, [join(root, "dist", "action-bundle", "index.js")], {
    cwd: root,
    env: {
      ...process.env,
      INPUT_CONFIG: configPath,
      "INPUT_COOLIFY-TOKEN": "fixture-token",
      "INPUT_EXPECTED-SHA": sha,
      "INPUT_REPORT-PATH": reportPath,
      GITHUB_OUTPUT: join(directory, "output"),
      GITHUB_STEP_SUMMARY: join(directory, "summary"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  action.stdout.on("data", (chunk) => { output += chunk.toString(); });
  action.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolveExit, reject) => {
    action.once("error", reject);
    action.once("exit", (exitCode) => resolveExit(exitCode));
  });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (code !== 0 || report.decision !== "PASS") {
    process.stderr.write(`${output}\n${JSON.stringify(report.checks, null, 2)}\n`);
    throw new Error(`Action consumer failed (${code}, ${report.decision}).`);
  }
  process.stdout.write("Clean Action consumer smoke passed.\n");
} finally {
  fixture.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
