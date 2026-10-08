import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "witness-agent-smoke-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const address = probe.address();
if (!address || typeof address === "string") throw new Error("Could not allocate agent port.");
const port = address.port;
await new Promise((resolveClose) => probe.close(resolveClose));

const child = spawn(process.execPath, [join(root, "apps", "agent", "dist", "index.js")], {
  cwd: root,
  env: {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    WITNESS_ROOT: root,
    WITNESS_PORT: String(port),
    WITNESS_DATA_DIR: directory,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  const token = await new Promise((resolveToken, reject) => {
    const timeout = setTimeout(() => reject(new Error("Agent did not start.")), 10_000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Agent exited before readiness.")));
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (output) => {
      clearTimeout(timeout);
      const match = /#token=([a-f0-9]{64})/.exec(output);
      if (match) resolveToken(match[1]);
      else reject(new Error("Agent did not provide a session URL."));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const denied = await fetch(`${origin}/api/health`);
  const allowed = await fetch(`${origin}/api/health`, { headers: { "X-Witness-Token": token } });
  const projects = await fetch(`${origin}/api/projects`, { headers: { "X-Witness-Token": token } });
  if (denied.status !== 401 || allowed.status !== 200 || projects.status !== 200) {
    throw new Error("Agent API session smoke failed.");
  }
  if (JSON.stringify(await projects.json()) !== "[]") throw new Error("Empty catalog smoke failed.");
  process.stdout.write("Agent session smoke passed.\n");
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
  await rm(directory, { recursive: true, force: true });
}
