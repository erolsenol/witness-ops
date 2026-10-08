import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const [directory, expectedSha] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("Fixture requires a directory and full commit SHA.");

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/api/v1/deployments/applications/local-app") {
    if (request.method !== "GET" || request.headers.authorization !== "Bearer fixture-token") {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{
      deployment_uuid: "local-deployment",
      status: "finished",
      commit: expectedSha,
      created_at: new Date().toISOString(),
    }]));
    return;
  }
  if (path === "/health" || path === "/version") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(
      path === "/health" ? { status: "ok" } : { build: { commit: expectedSha } },
    ));
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable.");
  const baseUrl = `http://localhost:${address.port}`;
  await writeFile(join(directory, "action-consumer.json"), JSON.stringify({
    version: 2,
    provider: "coolify",
    coolify: { baseUrl, resourceUuid: "local-app" },
    deployment: { timeoutSeconds: 10, pollIntervalSeconds: 1 },
    probes: [
      { name: "health", url: `${baseUrl}/health`, allowLocalHttp: true },
      { name: "runtime-version", url: `${baseUrl}/version`, allowLocalHttp: true, expectedJson: { path: "build.commit", value: expectedSha } },
    ],
  }), { mode: 0o600 });
});

process.once("SIGTERM", () => server.close());
