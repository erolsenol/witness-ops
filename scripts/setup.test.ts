import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("witness setup", () => {
  it("creates a private catalog once and preserves existing content", () => {
    const directory = mkdtempSync(join(tmpdir(), "witness-setup-"));
    const path = join(directory, "config", "projects.json");
    try {
      const env = { ...process.env, WITNESS_CONFIG: path };
      const first = spawnSync(process.execPath, ["src/setup.mjs"], { env, encoding: "utf8" });
      expect(first.status).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, projects: [] });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, "custom catalog\n");
      const second = spawnSync(process.execPath, ["src/setup.mjs"], { env, encoding: "utf8" });
      expect(second.status).toBe(0);
      expect(readFileSync(path, "utf8")).toBe("custom catalog\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
