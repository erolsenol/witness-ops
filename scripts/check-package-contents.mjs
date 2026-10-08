import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Provide an npm pack JSON file.");
const result = JSON.parse(readFileSync(path, "utf8"));
const packageInfo = Array.isArray(result) ? result[0] : result;
const paths = new Set(packageInfo.files?.map((file) => file.path) ?? []);
for (const required of [
  "src/cli.mjs",
  "src/setup.mjs",
  "apps/agent/dist/index.js",
  "apps/agent/dist/cli.js",
  "apps/console/dist/index.html",
  "packages/deploy-witness/dist/cli.js",
  "packages/restore-witness/dist/cli.js",
]) {
  if (!paths.has(required)) throw new Error(`npm package is missing ${required}.`);
}
if (packageInfo.name !== "@erol.senol/witness-ops") throw new Error("Unexpected npm package name.");
