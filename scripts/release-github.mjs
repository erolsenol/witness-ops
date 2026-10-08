import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getChecksumName, getReleaseTag, parseReleaseOptions } from "./release-github-cli.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args[0] ?? ""} failed (${result.status ?? result.error?.message}).`);
  return result.stdout?.trim() ?? "";
}

function output(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed (${result.status ?? result.error?.message}).`);
  return result.stdout.trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolvePromise));
  return hash.digest("hex");
}

function verifyCleanMain() {
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`Release requires main; current branch is ${branch || "detached"}.`);
  if (output("git", ["status", "--porcelain"])) throw new Error("Release requires a clean working tree.");
  const head = output("git", ["rev-parse", "HEAD"]);
  const remote = output("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0];
  if (!remote) throw new Error("Could not read origin/main.");
  if (head !== remote) throw new Error("Release commit must match origin/main. Push it before publishing.");
  return head;
}

function verifyWorkspaceVersions(version) {
  const manifests = ["package.json", "apps/agent/package.json", "apps/console/package.json", "apps/desktop/package.json", "packages/contracts/package.json", "packages/core/package.json", "packages/deploy-witness/package.json", "packages/restore-witness/package.json"];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    if (manifest.version !== version) throw new Error(`${manifestPath} version does not match root version ${version}.`);
  }
}

async function publish() {
  const { notesPath: suppliedNotesPath, dryRun } = parseReleaseOptions(process.argv.slice(2));
  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = packageManifest.version;
  const tag = getReleaseTag(version);
  const notesPath = resolve(suppliedNotesPath);
  if (!existsSync(notesPath)) throw new Error(`Release notes not found: ${notesPath}`);
  if (!readFileSync(notesPath, "utf8").trim()) throw new Error("Release notes must not be empty.");
  verifyWorkspaceVersions(version);
  const head = verifyCleanMain();
  const repository = JSON.parse(output("gh", ["repo", "view", "--json", "nameWithOwner,isPrivate"]));
  if (repository.nameWithOwner !== "erolsenol/witness-ops" || repository.isPrivate !== false) throw new Error(`Expected the public erolsenol/witness-ops repository; found ${repository.nameWithOwner ?? "unknown"}.`);
  command("gh", ["auth", "status"]);
  if (output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) throw new Error(`Git tag ${tag} already exists.`);
  if (spawnSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" }).status === 0) throw new Error(`GitHub release ${tag} already exists.`);
  const zip = join(root, "apps", "desktop", "out", "make", "zip", "darwin", "arm64", `WitnessOps-darwin-arm64-${version}.zip`);
  const checksumName = getChecksumName(version);
  const checksum = join(root, "apps", "desktop", "out", "make", checksumName);
  if (dryRun) { process.stdout.write(`Would validate ${head}, run local gates, build ${zip}, and create public prerelease ${tag}.\n`); return; }
  command("pnpm", ["run", "preflight"]);
  command("/Users/erolsenol/.local/bin/dev-run", ["--wait", "--", "pnpm", "check"]);
  command("/Users/erolsenol/.local/bin/dev-run", ["--wait", "--", "pnpm", "make:desktop"]);
  if (!existsSync(zip)) throw new Error(`Expected Apple Silicon package is missing: ${zip}`);
  command("unzip", ["-tq", zip]);
  const digest = await sha256(zip);
  writeFileSync(checksum, `${digest}  ${relative(dirname(checksum), zip)}\n`);
  command("shasum", ["-a", "256", "-c", checksumName], { cwd: dirname(checksum) });
  if (verifyCleanMain() !== head) throw new Error("Source changed while preparing the release; nothing was published.");
  const generatedNotes = mkdtempSync(join(tmpdir(), "witness-ops-release-"));
  try {
    const fullNotes = `${readFileSync(notesPath, "utf8").trim()}\n\n## Local verification\n\n- pnpm check passed before packaging.\n- Apple Silicon ZIP integrity and SHA-256 were verified locally.\n`;
    const generatedNotesPath = join(generatedNotes, "release-notes.md");
    writeFileSync(generatedNotesPath, fullNotes);
    const args = ["release", "create", tag, zip, checksum, "--title", `WitnessOps ${tag}`, "--target", head, "--notes-file", generatedNotesPath];
    if (tag.includes("-alpha.") || tag.includes("-beta.") || tag.includes("-rc.")) args.push("--prerelease");
    command("gh", args);
  } finally { rmSync(generatedNotes, { recursive: true, force: true }); }
  const releaseUrl = output("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"]);
  process.stdout.write(`Published ${tag}: ${releaseUrl}\nZIP SHA-256: ${digest}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await publish(); } catch (error) { process.stderr.write(`Release failed: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; }
}
