import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";

const agentOrigin = "http://127.0.0.1:3847";
let ownedAgent: ChildProcess | null = null;

const electronDataDirectory = join(homedir(), "Library", "Application Support", "WitnessOps", "electron");
mkdirSync(electronDataDirectory, { recursive: true, mode: 0o700 });
app.setName("WitnessOps");
app.setPath("userData", electronDataDirectory);

async function agentReady(): Promise<boolean> {
  try {
    const response = await fetch(`${agentOrigin}/api/health`, { signal: AbortSignal.timeout(1500) });
    const data: unknown = await response.json();
    return response.ok && typeof data === "object" && data !== null && "service" in data && data.service === "witness-ops-agent";
  } catch {
    return false;
  }
}

async function ensureAgent(): Promise<boolean> {
  if (await agentReady()) return true;
  const root = app.isPackaged ? join(process.resourcesPath, "agent") : resolve(app.getAppPath(), "../..");
  const entry = join(root, "apps", "agent", "dist", "index.js");
  if (!existsSync(entry)) return false;
  const localBin = join(homedir(), ".local", "bin");
  const node = process.env.WITNESS_NODE ?? (existsSync(join(localBin, "node")) ? join(localBin, "node") : "node");
  ownedAgent = spawn(node, [entry], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      WITNESS_ROOT: root,
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
    dialog.showErrorBox("WitnessOps agent başlatılamadı", "Node 24 kurulumunu ve yerel proje yapılandırmasını kontrol edin.");
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
  await window.loadURL(agentOrigin);
  window.show();
}

app.whenReady().then(() => { void createWindow(); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { ownedAgent?.kill("SIGTERM"); });
