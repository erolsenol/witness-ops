import { rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
for (const relative of [
  "apps/agent/dist",
  "apps/console/dist",
  "apps/desktop/dist",
  "packages/deploy-witness/dist",
  "packages/restore-witness/dist",
]) {
  rmSync(join(root, relative), { recursive: true, force: true });
}
