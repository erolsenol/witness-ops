import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configSchema, type Config } from "@deploy-relay/contracts";

export const dataDirectory = process.env.WITNESS_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "WitnessOps");

export function loadCatalog(): Config {
  const path = process.env.WITNESS_CONFIG ?? join(dataDirectory, "projects.json");
  if (!existsSync(path)) return { version: 1, projects: [] };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return configSchema.parse(raw);
}
