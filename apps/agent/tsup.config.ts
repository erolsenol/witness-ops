import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  external: ["better-sqlite3"],
  noExternal: ["@witness-ops/contracts", "@witness-ops/core"],
});
