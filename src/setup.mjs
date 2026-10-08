import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";

const directory = process.env.WITNESS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "WitnessOps");
const path = process.env.WITNESS_CONFIG ?? join(directory, "projects.json");
if (!isAbsolute(path)) throw new Error("WITNESS_CONFIG must be an absolute path.");
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
try {
  await writeFile(path, '{\n  "version": 1,\n  "projects": []\n}\n', { flag: "wx", mode: 0o600 });
  process.stdout.write(`Project catalog created: ${path}\n`);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    process.stdout.write(`Project catalog already exists: ${path}\n`);
  } else {
    throw error;
  }
}
process.stdout.write("Add project entries using config/projects.example.json, then run witness app.\n");
