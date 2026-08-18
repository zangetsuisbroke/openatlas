// Atlas Workspace desktop shell.
// Spawns the compiled atlas-workspace server, waits for it to come up,
// and shows a native window pointing at the local UI. Quitting the app
// tears down the server process tree cleanly.
const { app, BrowserWindow, dialog, Menu } = require("electron");
const { spawn, execSync } = require("child_process");
const { join, dirname } = require("path");
const { existsSync, readFileSync, writeFileSync } = require("fs");
const net = require("net");

const PREFS = join(app.getPath("userData"), "prefs.json");

function loadPrefs() {
  try {
    return JSON.parse(readFileSync(PREFS, "utf8"));
  } catch {
    return {};
  }
}

function savePrefs(p) {
  try {
    writeFileSync(PREFS, JSON.stringify(p, null, 2), "utf8");
  } catch (e) {
    console.error("[main] Failed to save prefs:", e.message);
  }
}

const prefs = loadPrefs();
let workspace = process.env.ATLAS_WORKSPACE || prefs.workspace || app.getPath("home");
let server = null;
let win = null;
let port = 0;
let ready = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function checkDependencies() {
  if (!app.isPackaged) return { ok: true, missing: [] };
  const missing = [];
  const check = (label, p) => { if (!existsSync(p)) missing.push(label); };

  const res = process.resourcesPath;
  const appDir = dirname(process.execPath);

  check("atlas-workspace.exe", join(res, "atlas-workspace.exe"));
  check("ffmpeg.dll", join(appDir, "ffmpeg.dll"));
  check("libEGL.dll", join(appDir, "libEGL.dll"));
  check("libGLESv2.dll", join(appDir, "libGLESv2.dll"));
  check("d3dcompiler_47.dll", join(appDir, "d3dcompiler_47.dll"));
  check("vulkan-1.dll", join(appDir, "vulkan-1.dll"));
  check("vk_swiftshader.dll", join(appDir, "vk_swiftshader.dll"));
  check("vendor/node-pty", join(res, "vendor", "node-pty", "lib", "index.js"));
  check("vendor/opencode/bin", join(res, "vendor", "opencode", "bin"));

  return { ok: missing.length === 0, missing };
}

function serverExe() {
  if (process.env.ATLAS_SERVER_EXE) return process.env.ATLAS_SERVER_EXE;
  if (app.isPackaged) {
    const packagedExe = join(process.resourcesPath, "atlas-workspace.exe");
    if (existsSync(packagedExe)) return packagedExe;
    console.error("[main] Packaged executable missing at:", packagedExe);
    return null;
  }
  // dev: prefer a freshly-built exe next to this repo, else fall back to source via bun
  const devExe = join(__dirname, "..", "workspace", "atlas-workspace.exe");
  if (existsSync(devExe)) return devExe;
  return null;
}

function killServerProcess(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    try {
      proc.kill();
    } catch {}
  }
}

function waitForServer(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = net.connect({ host: "127.0.0.1", port }, () => {
        req.destroy();
        resolve();
      });
      req.on("error", () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("Server did not respond within 20s timeout"));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

function pickWorkspace() {
  const dirs = dialog.showOpenDialogSync(win, {
    title: "Choose workspace folder to scan",
    defaultPath: workspace,
    properties: ["openDirectory", "createDirectory"],
  });
  if (!dirs || !dirs.length) return false;
  workspace = dirs[0];
  prefs.workspace = workspace;
  savePrefs(prefs);
  if (ready) restartServer();
  return true;
}

async function startServer() {
  port = await freePort();
  const exe = serverExe();
  
  if (app.isPackaged && !exe) {
    throw new Error(`Packaged backend binary 'atlas-workspace.exe' not found in resources folder: ${process.resourcesPath}`);
  }

  const env = {
    ...process.env,
    PORT: String(port),
    ATLAS_WORKSPACE: workspace,
    ATLAS_APP_DIR: join(app.getPath("userData"), "app"),
  };

  // Point the server at the vendored binaries shipped as package resources (they are
  // no longer embedded in the exe — embedding materialized ~300MB of base64 in its
  // heap). Falls back to the repo's vendor/ in dev.
  const vendorDir = app.isPackaged
    ? join(process.resourcesPath, "vendor")
    : join(__dirname, "..", "workspace", "vendor");
  const nodePty = join(vendorDir, "node-pty", "lib", "index.js");
  if (existsSync(nodePty)) env.ATLAS_NODE_PTY = nodePty;
  const opencodeBin = join(vendorDir, "opencode", "bin");
  if (existsSync(opencodeBin)) env.ATLAS_OPENCODE_DIR = opencodeBin;

  if (!exe) {
    // dev mode without compiled exe: run source via bun
    server = spawn("bun", ["server/index.ts"], {
      cwd: join(__dirname, "..", "workspace"),
      env,
      windowsHide: true,
    });
  } else {
    server = spawn(exe, [], { 
      env, 
      cwd: dirname(exe),
      windowsHide: true 
    });
  }

  server.on("error", (e) => console.error("[main] spawn error:", e.message));
  server.stderr.on("data", (d) => console.error("[server:err]", String(d).trim().slice(0, 500)));
  server.stdout.on("data", (d) => console.log("[server:out]", String(d).trim().slice(0, 500)));
  server.on("exit", (code) => {
    console.log(`[main] server exited with code ${code}`);
    if (ready && code !== 0) {
      ready = false;
      setTimeout(() => startServer().then(attach).catch((err) => {
        console.error("[main] Failed to revive server:", err.message);
      }), 2000);
    }
  });

  await waitForServer(20000);
}

function attach() {
  if (win && !win.isDestroyed() && port > 0) {
    win.loadURL(`http://127.0.0.1:${port}/index.html`).catch((err) => {
      console.error("[main] loadURL error:", err.message);
    });
  }
}

// Inline HTML loading screen so window never stays black
const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      background: #0c0b09;
      color: #f0eae0;
      font-family: system-ui, -apple-system, sans-serif;
      height: 100vh;
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      user-select: none;
    }
    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(240,234,224,0.1);
      border-top-color: #d62f22;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 1.25rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .title { font-weight: 600; font-size: 1.1rem; margin-bottom: 0.35rem; letter-spacing: 0.04em; }
    .subtitle { color: #9b9183; font-size: 0.85rem; font-family: monospace; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="title">Initializing Atlas Workspace</div>
  <div class="subtitle">Starting local SQLite memory engine...</div>
</body>
</html>
`)}`;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0c0b09",
    title: "Atlas Workspace",
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load splash screen immediately
  win.loadURL(LOADING_HTML);

  win.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] Did fail load (${errorCode}): ${errorDescription} at ${validatedURL}`);
    if (port > 0) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.loadURL(`http://127.0.0.1:${port}/index.html`).catch(() => {});
        }
      }, 1000);
    }
  });

  win.on("closed", () => (win = null));
  if (ready && port) attach();
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Open Workspace Folder…", accelerator: "Ctrl+O", click: pickWorkspace },
          { type: "separator" },
          { label: "Quit", accelerator: "Ctrl+Q", click: () => app.quit() },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload", accelerator: "Ctrl+R" },
          { role: "forceReload", accelerator: "Ctrl+Shift+R" },
          { role: "toggleDevTools", accelerator: "Ctrl+Shift+I" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn", accelerator: "Ctrl+=" },
          { role: "zoomOut", accelerator: "Ctrl+-" },
          { type: "separator" },
          { role: "togglefullscreen", accelerator: "F11" },
        ],
      },
      { role: "windowMenu" },
    ])
  );
}

async function restartServer() {
  if (server) {
    killServerProcess(server);
    server = null;
  }
  ready = false;
  try {
    await startServer();
    ready = true;
    attach();
  } catch (e) {
    dialog.showErrorBox("Atlas Workspace", `Could not restart server: ${e.message}`);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();

    const deps = checkDependencies();
    if (!deps.ok) {
      dialog.showErrorBox(
        "Atlas Workspace — Missing Files",
        "The following required files are missing:\n\n" +
          deps.missing.map(f => `  • ${f}`).join("\n") +
          "\n\nPlease re-download Atlas from:\nhttps://github.com/zangetsuisbroke/openatlas/releases/latest/download/AtlasWorkspaceNew-0.1.0-win.zip"
      );
      app.quit();
      return;
    }

    try {
      // First run: never default to scanning the entire home directory.
      // Ask once for a real workspace folder before the server boots.
      if (!prefs.workspace && !process.env.ATLAS_WORKSPACE) {
        if (!pickWorkspace()) {
          dialog.showErrorBox(
            "Atlas Workspace",
            "No workspace folder was selected.\n\nAtlas won't scan your home directory by default. Close and relaunch, then choose a folder to scan."
          );
          app.quit();
          return;
        }
      }
      await startServer();
      ready = true;
      attach();
    } catch (e) {
      dialog.showErrorBox("Atlas Workspace Error", `Could not start backend server:\n\n${e.message}`);
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  
  const cleanup = () => {
    if (server) {
      killServerProcess(server);
      server = null;
    }
  };

  app.on("before-quit", cleanup);
  app.on("will-quit", cleanup);
}
