import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const shaPattern = /^[a-f0-9]{40}$/;

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: options.cwd, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe", timeout: 2 * 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: process.env });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args[0] ?? ""} failed (${result.status ?? "not started"}).`);
  return (result.stdout ?? "").trim();
}

export function validateEvidence(evidence, expectedSha) {
  if (!evidence || evidence.version !== 1 || evidence.sha !== expectedSha || evidence.state !== "passed" || evidence.cleanSource !== true || evidence.node !== "22.23.3" || evidence.pnpm !== "12.4.2" || !Array.isArray(evidence.gates) || !evidence.gates.some((gate) => gate?.executable === "pnpm" && gate.args?.[0] === "build" && gate.state === "passed")) throw new Error("WordLangLab clean-source release build evidence is invalid.");
  return evidence;
}

export function verifyWordLangLabBuild(manifestPath) {
  const file = resolve(manifestPath);
  const expectedRoot = resolve(process.cwd(), ".release-artifacts", "witness-ops");
  if (!file.startsWith(`${expectedRoot}/`)) throw new Error("WordLangLab build evidence is outside the expected private directory.");
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
  if (!shaPattern.test(sha) || file !== resolve(expectedRoot, `${sha}.json`)) throw new Error("WordLangLab build evidence does not match the current commit.");
  validateEvidence(evidence, sha);
}

export function runWordLangLabBuild(expectedSha) {
  if (!shaPattern.test(expectedSha)) throw new Error("A full WordLangLab commit SHA is required.");
  const root = process.cwd();
  if (run("git", ["rev-parse", "HEAD"], { cwd: root }) !== expectedSha) throw new Error("WordLangLab source changed before its release build.");
  run("pnpm", ["release:local:build"], { cwd: root, inherit: true });
  if (run("git", ["rev-parse", "HEAD"], { cwd: root }) !== expectedSha || run("git", ["status", "--porcelain"], { cwd: root }) !== "") throw new Error("WordLangLab source changed during its release build.");
  const evidenceDirectory = resolve(root, ".release-artifacts", "checks");
  const matchingFiles = readdirSync(evidenceDirectory).filter((name) => /^\d+-[a-f0-9]{40}\.json$/.test(name) && name.endsWith(`-${expectedSha}.json`)).sort().reverse();
  const evidence = matchingFiles.map((name) => JSON.parse(readFileSync(resolve(evidenceDirectory, name), "utf8"))).find((candidate) => candidate.sha === expectedSha && candidate.state === "passed");
  validateEvidence(evidence, expectedSha);
  const outputDirectory = resolve(root, ".release-artifacts", "witness-ops");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = resolve(outputDirectory, `${expectedSha}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  verifyWordLangLabBuild(manifestPath);
  process.stdout.write(`Verified WordLangLab build evidence: ${manifestPath}\n`);
}

const [action, argument] = process.argv.slice(2);
if (action === "build" && shaPattern.test(argument ?? "")) runWordLangLabBuild(argument);
else if (action === "verify" && argument) verifyWordLangLabBuild(argument);
else if (action !== undefined) throw new Error("Usage: wordlanglab-build.mjs build <sha> | verify <manifest>");
