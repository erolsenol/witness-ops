import { spawn } from "node:child_process";

const target = process.env.WITNESS_SSH_TARGET;
const remotePort = Number(process.env.WITNESS_REMOTE_PORT ?? "31847");
const localPort = Number(process.env.WITNESS_PORT ?? "3847");

if (!target || !/^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/i.test(target)) {
  throw new Error("Set WITNESS_SSH_TARGET to user@host.");
}
for (const port of [remotePort, localPort]) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid tunnel port.");
}

const child = spawn("ssh", [
  "-N", "-T",
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=yes",
  "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
  target,
], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  process.stderr.write(`Could not start SSH tunnel: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code) => { process.exitCode = code ?? 1; });
