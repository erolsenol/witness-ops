import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const target = join(root, "dist", "action-bundle");
mkdirSync(target, { recursive: true });
cpSync(join(root, "packages", "deploy-witness", "dist", "action-bundle", "index.js"), join(target, "index.js"));
