import { describe, expect, it } from "vitest";
import type { Project } from "@witness-ops/contracts";
import { CoolifyReader } from "./coolify.ts";

const project: Project = {
  id: "example", name: "Example", root: "/tmp/example", productionBranch: "main",
  nodeVersion: "22.23.3", packageManager: "npm@11", coolifyApplications: ["allowed"],
  checks: [{ label: "Check", command: "npm", args: ["test"] }],
};

describe("CoolifyReader", () => {
  it("does not call the API without a token", async () => {
    const reader = new CoolifyReader(undefined, "https://coolify.example", async () => {
      throw new Error("Unexpected request");
    });
    expect((await reader.read([project])).availability).toBe("not_configured");
  });

  it("returns only configured applications and caches the sanitized snapshot", async () => {
    let requests = 0;
    const reader = new CoolifyReader("secret", "https://coolify.example", async (url, init) => {
      requests += 1;
      expect(url.href).toBe("https://coolify.example/api/v1/applications");
      expect(init.headers).toMatchObject({ Authorization: "Bearer secret" });
      return Response.json([
        { uuid: "allowed", name: "App", status: "running:healthy", fqdn: null, git_branch: "main", build_pack: "dockercompose", environment_variables: "must-not-leak" },
        { uuid: "other", name: "Other", status: "running:healthy", fqdn: null },
      ]);
    });
    const snapshot = await reader.read([project]);
    expect(snapshot.applications).toEqual([{ uuid: "allowed", name: "App", status: "running:healthy", fqdn: null, branch: "main", buildPack: "dockercompose" }]);
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    await reader.read([project]);
    expect(requests).toBe(1);
  });

  it("reports an API failure without exposing response text", async () => {
    const reader = new CoolifyReader("secret", "https://coolify.example", async () => new Response("private error", { status: 401 }));
    const snapshot = await reader.read([project]);
    expect(snapshot.availability).toBe("unavailable");
    expect(snapshot.error).toBe("Coolify API returned HTTP 401.");
    expect(JSON.stringify(snapshot)).not.toContain("private error");
  });
});
