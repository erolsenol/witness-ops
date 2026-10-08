import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Project, ProjectState } from "@deploy-relay/contracts";
import { buildProject, checkProject, deployProject, rollbackProject, safeStepDiagnostic } from "./index.ts";

const project: Project = {
  id: "example",
  name: "Example",
  root: "/tmp/example",
  productionBranch: "main",
  nodeVersion: "22.23.3",
  packageManager: "npm@11",
  coolifyApplications: [],
  checks: [
    { label: "Lint", command: "npm", args: ["run", "lint"] },
    { label: "Test", command: "npm", args: ["test"] },
  ],
};

const cleanState: ProjectState = {
  id: "example",
  name: "Example",
  branch: "main",
  sha: "a".repeat(40),
  clean: true,
  error: null,
  productionBranch: "main",
  coolifyApplications: [],
  buildAvailable: false,
  deployAvailable: false,
  rollbackAvailable: false,
  deployVerificationAvailable: false,
  databaseRecoveryAvailable: false,
};

describe("checkProject", () => {
  it("runs checks in order and returns the stable SHA", async () => {
    const calls: string[] = [];
    const sha = await checkProject(project, {
      inspect: () => cleanState,
      nodeVersion: "22.23.3",
      onStep: (message) => calls.push(message),
      executeStep: async (_project, command, args) => { calls.push(`${command} ${args.join(" ")}`); },
    });
    expect(sha).toBe(cleanState.sha);
    expect(calls).toEqual([
      "Lint started", "npm run lint", "Lint passed",
      "Test started", "npm test", "Test passed",
    ]);
  });

  it("refuses a dirty source without executing", async () => {
    let executed = false;
    await expect(checkProject(project, {
      inspect: () => ({ ...cleanState, clean: false }),
      nodeVersion: "22.23.3",
      onStep: () => undefined,
      executeStep: async () => { executed = true; },
    })).rejects.toThrow(/dirty/);
    expect(executed).toBe(false);
  });

  it("rejects a source change after checks", async () => {
    let inspections = 0;
    await expect(checkProject(project, {
      inspect: () => (++inspections === 1 ? cleanState : { ...cleanState, sha: "b".repeat(40) }),
      nodeVersion: "22.23.3",
      onStep: () => undefined,
      executeStep: async () => undefined,
    })).rejects.toThrow(/Source changed/);
  });
});

describe("safeStepDiagnostic", () => {
  it("retains an audit count without copying arbitrary output", () => {
    expect(safeStepDiagnostic("75 vulnerabilities (16 moderate, 58 high, 1 critical)"))
      .toBe("75 vulnerabilities (16 moderate, 58 high, 1 critical)");
    expect(safeStepDiagnostic("DATABASE_URL=postgresql://private.example/secret")).toBeNull();
  });
});

describe("rollbackProject", () => {
  it("requires a clean production checkout and verifies the selected SHA", async () => {
    const targetSha = "b".repeat(40);
    const calls: string[] = [];
    let started = false;
    const rollbackable: Project = {
      ...project,
      rollback: {
        label: "Native rollback", command: "npm", args: ["run", "rollback", "app-{sha}"],
        smoke: { label: "Target smoke", command: "npm", args: ["run", "smoke", "--", "--commit={sha}"] },
      },
    };
    await rollbackProject(rollbackable, targetSha, {
      inspect: () => cleanState,
      nodeVersion: "22.23.3",
      onStep: () => undefined,
      executeStep: async (_project, command, args) => { calls.push(`${command} ${args.join(" ")}`); },
    }, () => { started = true; });
    expect(started).toBe(true);
    expect(calls).toEqual([
      "npm run rollback app-" + targetSha,
      "npm run smoke -- --commit=" + targetSha,
    ]);
  });

  it("does not start a rollback from a dirty or non-production checkout", async () => {
    let started = false;
    const rollbackable: Project = {
      ...project,
      rollback: {
        label: "Native rollback", command: "npm", args: ["run", "rollback", "app-{sha}"],
        smoke: { label: "Target smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
      },
    };
    await expect(rollbackProject(rollbackable, "b".repeat(40), {
      inspect: () => ({ ...cleanState, clean: false }),
      nodeVersion: "22.23.3", onStep: () => undefined, executeStep: async () => undefined,
    }, () => { started = true; })).rejects.toThrow(/clean main checkout/);
    expect(started).toBe(false);
  });
});

describe("buildProject", () => {
  const buildable: Project = {
    ...project,
    build: {
      label: "Bundle", command: "npm", args: ["run", "release:build"],
      manifest: ".release-artifacts/{sha}/manifest.json",
      verify: { label: "Verify", command: "npm", args: ["run", "release:verify", "{manifest}"] },
    },
  };

  it("refuses a different branch before running checks", async () => {
    let executed = false;
    await expect(buildProject(buildable, {
      inspect: () => ({ ...cleanState, branch: "development" }),
      nodeVersion: "22.23.3",
      onStep: () => undefined,
      executeStep: async () => { executed = true; },
    })).rejects.toThrow(/requires the main branch/);
    expect(executed).toBe(false);
  });

  it("rejects a missing manifest after native build", async () => {
    await expect(buildProject(buildable, {
      inspect: () => cleanState,
      nodeVersion: "22.23.3",
      onStep: () => undefined,
      executeStep: async () => undefined,
    })).rejects.toThrow(/manifest is missing/);
  });

  it("verifies the native manifest and records its digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-relay-build-"));
    const manifest = join(root, ".release-artifacts", cleanState.sha!, "manifest.json");
    const calls: string[] = [];
    try {
      const result = await buildProject({ ...buildable, root }, {
        inspect: () => cleanState,
        nodeVersion: "22.23.3",
        onStep: () => undefined,
        executeStep: async (_project, command, args) => {
          calls.push(`${command} ${args.join(" ")}`);
          if (args.includes("release:build")) {
            mkdirSync(join(root, ".release-artifacts", cleanState.sha!), { recursive: true });
            writeFileSync(manifest, "verified bundle");
          }
        },
      });
      expect(result.sha).toBe(cleanState.sha);
      expect(result.manifest).toBe(manifest);
      expect(result.manifestHash).toBe(createHash("sha256").update("verified bundle").digest("hex"));
      expect(calls.at(-1)).toBe(`npm run release:verify ${manifest}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires matching bundle evidence before any deploy command", async () => {
    let executed = false;
    await expect(deployProject({ ...buildable, deploy: {
      label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"],
      smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
    } }, { sha: "b".repeat(40), manifest: "/tmp/missing", manifestHash: "c".repeat(64) }, {
      inspect: () => cleanState, nodeVersion: "22.23.3", onStep: () => undefined,
      executeStep: async () => { executed = true; },
    }, () => { executed = true; })).rejects.toThrow(/same clean production-branch SHA/);
    expect(executed).toBe(false);
  });

  it("verifies, deploys, and smokes only the recorded manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "deploy-relay-deploy-"));
    const manifest = join(root, ".release-artifacts", cleanState.sha!, "manifest.json");
    const calls: string[] = [];
    let deploymentStarted = false;
    try {
      mkdirSync(join(root, ".release-artifacts", cleanState.sha!), { recursive: true });
      writeFileSync(manifest, "bundle");
      const deployable: Project = { ...buildable, root, deploy: {
        label: "Deploy", command: "npm", args: ["run", "deploy", "{manifest}"],
        smoke: { label: "Smoke", command: "npm", args: ["run", "smoke", "{sha}"] },
      } };
      await deployProject(deployable, {
        sha: cleanState.sha!, manifest,
        manifestHash: createHash("sha256").update("bundle").digest("hex"),
      }, {
        inspect: () => cleanState, nodeVersion: "22.23.3", onStep: () => undefined,
        executeStep: async (_project, command, args) => { calls.push(`${command} ${args.join(" ")}`); },
      }, () => { deploymentStarted = true; });
      expect(deploymentStarted).toBe(true);
      expect(calls).toEqual([
        `npm run release:verify ${manifest}`,
        `npm run deploy ${manifest}`,
        `npm run smoke ${cleanState.sha}`,
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
