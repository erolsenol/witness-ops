import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigLoadError,
  loadConfig,
  loadConfigDetails,
} from "../src/config/load.js";

const dirs: string[] = [];
async function configFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deploy-witness-"));
  dirs.push(dir);
  const path = join(dir, "deploy-witness.yml");
  await writeFile(path, content);
  return path;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("configuration loading", () => {
  it("loads a valid strict configuration", async () => {
    const config = await loadConfig(
      await configFile(
        `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  expectedSha: ${"a".repeat(40)}\n`,
      ),
    );
    expect(config.deployment.timeoutSeconds).toBe(600);
    expect(config.probes).toEqual([]);
  });

  it("loads config v2 image digest expectations", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const config = await loadConfig(
      await configFile(
        `version: 2\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  expectedImageDigest: ${digest}\nprobes:\n  - name: image\n    url: https://app.example.test/version\n    imageDigestJsonPath: build.imageDigest\n`,
      ),
    );
    expect(config.version).toBe(2);
    expect(
      "expectedImageDigest" in config.deployment &&
        config.deployment.expectedImageDigest,
    ).toBe(digest);
    expect(config.probes[0]).toMatchObject({
      name: "image",
      imageDigestJsonPath: "build.imageDigest",
    });
  });

  it("requires an expected digest for runtime image digest markers", async () => {
    await expect(
      loadConfig(
        await configFile(
          "version: 2\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment: {}\nprobes:\n  - name: image\n    url: https://app.example.test/version\n    imageDigestJsonPath: build.imageDigest\n",
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("allows an environment supplied digest to satisfy a config v2 runtime marker", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const path = await configFile(
      "version: 2\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment: {}\nprobes:\n  - name: image\n    url: https://app.example.test/version\n    imageDigestJsonPath: build.imageDigest\n",
    );
    const config = await loadConfig(path, {
      env: { DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST: digest },
    });

    expect(config.deployment).toMatchObject({ expectedImageDigest: digest });
  });

  it("rejects ambiguous runtime marker configuration", async () => {
    await expect(
      loadConfig(
        await configFile(
          `version: 2\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  expectedImageDigest: sha256:${"a".repeat(64)}\nprobes:\n  - name: image\n    url: https://app.example.test/version\n    imageDigestJsonPath: build.imageDigest\n    expectedJson:\n      path: commit\n      value: ${"b".repeat(40)}\n`,
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("applies the image digest environment override to config v2", async () => {
    const fileDigest = `sha256:${"a".repeat(64)}`;
    const envDigest = `sha256:${"b".repeat(64)}`;
    const path = await configFile(
      `version: 2\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  expectedImageDigest: ${fileDigest}\n`,
    );
    const loaded = await loadConfigDetails(path, {
      env: { DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST: envDigest },
    });

    expect(loaded.config.deployment).toMatchObject({
      expectedImageDigest: envDigest,
    });
    expect(loaded.appliedOverrides).toContain(
      "DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST",
    );
    expect(JSON.stringify(loaded.appliedOverrides)).not.toContain(envDigest);
  });

  it("keeps config v1 strict and requires the new schema version for image digests", async () => {
    await expect(
      loadConfig(
        await configFile(
          `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  expectedImageDigest: sha256:${"a".repeat(64)}\n`,
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects unsupported config schema versions", async () => {
    const path = await configFile(
      "version: 3\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment: {}\n",
    );
    await expect(loadConfig(path)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("accepts an ISO run-start boundary for deployment correlation", async () => {
    const config = await loadConfig(
      await configFile(
        `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  startedAfter: 2026-09-30T08:00:00Z\n`,
      ),
    );
    expect(config.deployment.startedAfter).toBe("2026-09-30T08:00:00Z");
  });

  it("applies documented environment overrides over file values without returning values in metadata", async () => {
    const path = await configFile(
      `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://file.example.test\n  resourceUuid: file-app\ndeployment:\n  expectedSha: ${"a".repeat(40)}\n`,
    );
    const loaded = await loadConfigDetails(path, {
      env: {
        DEPLOY_WITNESS_COOLIFY_BASE_URL: "https://env.example.test",
        DEPLOY_WITNESS_COOLIFY_RESOURCE_UUID: "env-app",
        DEPLOY_WITNESS_EXPECTED_SHA: "b".repeat(40),
        DEPLOY_WITNESS_STARTED_AFTER: "2026-09-30T08:00:00Z",
      },
    });

    if (loaded.config.provider !== "coolify")
      throw new Error("Expected a Coolify configuration.");
    expect(loaded.config.coolify.baseUrl).toBe("https://env.example.test");
    expect(loaded.config.coolify.resourceUuid).toBe("env-app");
    expect(loaded.config.deployment.expectedSha).toBe("b".repeat(40));
    expect(loaded.config.deployment.startedAfter).toBe("2026-09-30T08:00:00Z");
    expect(loaded.appliedOverrides).toEqual([
      "DEPLOY_WITNESS_COOLIFY_BASE_URL",
      "DEPLOY_WITNESS_COOLIFY_RESOURCE_UUID",
      "DEPLOY_WITNESS_EXPECTED_SHA",
      "DEPLOY_WITNESS_STARTED_AFTER",
    ]);
    expect(JSON.stringify(loaded.appliedOverrides)).not.toContain("env-app");
  });

  it("reports invalid environment overrides without echoing their values", async () => {
    const path = await configFile(
      `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://file.example.test\n  resourceUuid: file-app\ndeployment: {}\n`,
    );

    await expect(
      loadConfig(path, {
        env: { DEPLOY_WITNESS_COOLIFY_BASE_URL: "not-a-url-secret-value" },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      loadConfig(path, {
        env: { DEPLOY_WITNESS_COOLIFY_BASE_URL: "not-a-url-secret-value" },
      }),
    ).rejects.not.toThrow("not-a-url-secret-value");
  });

  it("applies Vercel project, team, and target environment overrides", async () => {
    const path = await configFile(
      `version: 1\nprovider: vercel\nvercel:\n  projectId: file-project\n  target: preview\ndeployment: {}\n`,
    );
    const config = await loadConfig(path, {
      env: {
        DEPLOY_WITNESS_VERCEL_PROJECT_ID: "prj_environment",
        DEPLOY_WITNESS_VERCEL_TEAM_ID: "team_environment",
        DEPLOY_WITNESS_VERCEL_TARGET: "production",
      },
    });

    if (config.provider !== "vercel")
      throw new Error("Expected a Vercel configuration.");
    expect(config.vercel).toMatchObject({
      projectId: "prj_environment",
      teamId: "team_environment",
      target: "production",
    });
  });

  it("rejects unknown credential fields without echoing their value", async () => {
    const path = await configFile(
      `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment:\n  token: super-secret-value\n`,
    );
    await expect(loadConfig(path)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(loadConfig(path)).rejects.not.toThrow("super-secret-value");
  });

  it("rejects malformed YAML with a value-free error", async () => {
    await expect(
      loadConfig(await configFile("provider: [")),
    ).rejects.toMatchObject({ code: "CONFIG_YAML_INVALID" });
  });

  it("rejects sensitive response marker headers", async () => {
    const path = await configFile(
      `version: 1\nprovider: coolify\ncoolify:\n  baseUrl: https://coolify.example.test\n  resourceUuid: app-1\ndeployment: {}\nprobes:\n  - name: health\n    url: https://app.example.test/health\n    expectedHeader:\n      name: Set-Cookie\n      value: private\n`,
    );
    await expect(loadConfig(path)).rejects.toBeInstanceOf(ConfigLoadError);
  });
});
