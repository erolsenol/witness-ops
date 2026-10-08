import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";

const agentToken = randomBytes(32).toString("hex");
let agentOrigin = "";
let ownedAgent: ChildProcess | null = null;

const electronDataDirectory = join(homedir(), "Library", "Application Support", "WitnessOps", "electron");
mkdirSync(electronDataDirectory, { recursive: true, mode: 0o700 });
app.setName("WitnessOps");
app.setPath("userData", electronDataDirectory);

async function agentReady(): Promise<boolean> {
  try {
    const response = await fetch(`${agentOrigin}/api/health`, {
      headers: { "X-Witness-Token": agentToken },
      signal: AbortSignal.timeout(1500),
    });
    const data: unknown = await response.json();
    return response.ok && typeof data === "object" && data !== null && "service" in data && data.service === "witness-ops-agent";
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not allocate a local agent port."));
        return;
      }
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function ensureAgent(): Promise<boolean> {
  agentOrigin = `http://127.0.0.1:${await availablePort()}`;
  const root = app.isPackaged ? join(process.resourcesPath, "agent") : resolve(app.getAppPath(), "../..");
  const entry = join(root, "apps", "agent", "dist", "index.js");
  if (!existsSync(entry)) return false;
  const localBin = join(homedir(), ".local", "bin");
  const bundledNode = join(root, "bin", "node");
  const node = process.env.WITNESS_NODE ?? (existsSync(bundledNode) ? bundledNode : existsSync(join(localBin, "node")) ? join(localBin, "node") : "node");
  ownedAgent = spawn(node, [entry], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      WITNESS_ROOT: root,
      WITNESS_PORT: new URL(agentOrigin).port,
      WITNESS_AUTH_TOKEN: agentToken,
      PATH: `${localBin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });
  ownedAgent.once("error", () => { ownedAgent = null; });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await agentReady()) return true;
    if (ownedAgent === null || ownedAgent.exitCode !== null || ownedAgent.signalCode !== null) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function createWindow(): Promise<void> {
  if (!await ensureAgent()) {
    dialog.showErrorBox("WitnessOps agent başlatılamadı", "Yerel proje yapılandırmasını ve uygulama paketini kontrol edin.");
    app.quit();
    return;
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 650,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${agentOrigin}/`)) event.preventDefault();
  });
  await window.loadURL(`${agentOrigin}/#token=${agentToken}`);
  window.show();
}

app.whenReady().then(() => { void createWindow(); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { ownedAgent?.kill("SIGTERM"); });
