// The desktop shell.
//
// This app does not reimplement the vault. It starts the same server the command
// line starts, waits for it to listen, and loads the same pages in a window. There
// is one implementation of the crypto, one of the parser and one of the interface,
// and a bug fixed in any of them is fixed here.
//
// What the shell adds is what a page in a tab cannot have: a real window with no
// address bar to phish with, a global shortcut, a tray item that locks the vault
// when you walk away, and a vault directory that belongs to the application rather
// than to whatever folder the terminal was in.
//
// Everything privileged lives in this file. The renderer is sandboxed, has no Node
// integration and talks to the server over loopback like the browser does, so a
// compromise in the page cannot reach the file system through the shell.

const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

const isDev = !app.isPackaged;
const ROOT = join(__dirname, "..");

/** The port the embedded server listens on. Loopback only. */
const PORT = Number(process.env.HASP_PORT || 3123);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * Where the vault lives.
 *
 * In a packaged build this is the user data directory, not the folder the app was
 * installed into, because an application directory is read only on macOS and is
 * replaced on update everywhere. Losing a vault to an update is not recoverable.
 */
const VAULT_DIR = isDev ? join(ROOT, ".vault") : join(app.getPath("userData"), "vault");

let mainWindow = null;
let tray = null;
let server = null;
let quitting = false;

/* ------------------------------------------------------------------ server */

/**
 * Start the vault server as a child process.
 *
 * Spawned rather than imported: the server calls process.exit and owns signal
 * handlers, and running it in process would take the window down with it. As a
 * child, a crash is restartable and the shell can say so.
 */
function startServer() {
  mkdirSync(VAULT_DIR, { recursive: true });

  server = spawn(process.execPath, [join(ROOT, "server.mjs"), `--port=${PORT}`], {
    cwd: VAULT_DIR,
    env: {
      ...process.env,
      // electron's execPath is the electron binary, which needs ELECTRON_RUN_AS_NODE
      // to behave like node. Without it the child tries to open a window.
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      HASP_VAULT_DIR: VAULT_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");

  server.stderr.on("data", (chunk) => {
    // The server never logs a secret. If it ever starts, this is where it would
    // surface, so it is passed through rather than swallowed.
    console.error("[vault]", String(chunk).trim());
  });

  server.on("exit", (code) => {
    if (quitting) return;
    console.error(`[vault] exited with ${code}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("vault:down", { code });
    }
  });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const poll = () => {
      const req = http.get(`${ORIGIN}/api/session`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("The vault did not start."));
        setTimeout(poll, 150);
      });
    };
    poll();
  });
}

function stopServer() {
  quitting = true;
  if (!server || server.killed) return;
  try {
    server.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#14161a",
    // The title bar is drawn by the app, which keeps the name and the lock state
    // in one place rather than behind a native menu the page cannot see.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      // The renderer is a web page. It gets no Node, no remote module and an
      // isolated context, so the page is exactly as powerful as the browser tab.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // A link to the documentation opens in the real browser rather than replacing
  // the vault, and only http and https are ever handed to the operating system.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  // Refuse to load anything that is not the vault itself. A remote navigation here
  // would be a page with the vault's window and none of its guarantees.
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  mainWindow.loadURL(`${ORIGIN}/app`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* -------------------------------------------------------------------- tray */

/**
 * What a round means, in a sentence.
 *
 * Split out from the request so it can be tested without a window or a network. The
 * tray has no room for a paragraph, so every branch returns one short sentence and a
 * flag saying whether the vault did what it was asked.
 *
 * @param {number} status
 * @param {object} body the parsed reply
 */
function describeRound(status, body) {
  // A locked vault answers 401 here, because the round is behind the session gate.
  // 423 is kept as well: the phone routes use it for the same meaning, and a route
  // that switches to it later should not turn this into "the vault answered 423".
  if (status === 401 || status === 423) return { ok: false, text: "The vault is locked. Unlock it to sync." };
  if (status === 409) return { ok: false, text: "Sync is off for this vault." };
  if (status < 200 || status >= 300) return { ok: false, text: body?.error || `The vault answered ${status}.` };
  const conflicts = body?.conflicts?.length || 0;
  if (conflicts) {
    // Not a failure. It is a decision waiting to be made, and saying so is the
    // difference between "something broke" and "go and look at this".
    return {
      ok: false,
      text: `${conflicts} item${conflicts === 1 ? "" : "s"} changed on two machines. Open Settings to compare.`,
      conflicts,
    };
  }
  const applied = body?.pulled?.applied ?? 0;
  const pushed = body?.pushed ?? 0;
  if (!applied && !pushed) return { ok: true, text: "Already up to date." };
  return { ok: true, text: `${applied} in, ${pushed} out.` };
}

/**
 * Run one sync round and describe it in a sentence.
 *
 * The shell does not reimplement sync. It calls the route the panel calls, so a bug
 * fixed in one is fixed in both, and the tray cannot drift from what Settings says.
 *
 * A conflict is not an error here. It is a decision waiting to be made, so it is
 * reported as one rather than as a failure.
 */
async function runSyncRound() {
  try {
    const res = await fetch(`${ORIGIN}/api/sync/round`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: 0 }),
    });
    const body = await res.json().catch(() => ({}));
    // A locked vault answers 401 here, because the round is behind the session gate.
    // 423 is kept as well: the phone routes use it for the same meaning, and a route
    // that switches to it later should not turn this sentence into "the vault
    // answered 423".
    return describeRound(res.status, body);
  } catch {
    return { ok: false, text: "The vault did not answer." };
  }
}

/** Tell the user what a round did, without stealing focus. */
function report(win, message) {
  if (win && !win.isDestroyed()) win.webContents.send("hasp:notice", message);
}

function createTray() {
  const icon = nativeImage.createFromPath(join(__dirname, "icons", "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Hasp");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Hasp", click: showWindow },
      { type: "separator" },
      {
        label: "Lock the vault",
        click: async () => {
          try {
            await fetch(`${ORIGIN}/api/lock`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            });
          } catch {
            // The vault may already be gone.
          }
          if (mainWindow) mainWindow.webContents.send("vault:locked");
        },
      },
      { type: "separator" },
      {
        label: "Sync now",
        click: async () => {
          const result = await runSyncRound();
          // The tray has no room for a paragraph, so the tooltip carries the sentence
          // and the window gets a notice that says the same thing.
          if (tray && !tray.isDestroyed()) tray.setToolTip(`Hasp. ${result.text}`);
          report(mainWindow, result.text);
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

/* --------------------------------------------------------------------- app */

// One instance. A second launch focuses the first, because two processes writing
// one vault file is a corruption the schema does not prevent.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox(
        "Hasp could not start",
        `The vault server did not come up on port ${PORT}.\n\n${err.message}\n\nAnother copy may already be running.`,
      );
      app.quit();
      return;
    }

    createWindow();
    createTray();

    // Summon the window from anywhere. The shortcut locks the vault on the way
    // out, so walking away from the machine does not leave it open behind a lock
    // screen.
    globalShortcut.register("CommandOrControl+Shift+H", showWindow);

    app.on("activate", showWindow);
  });

  // Closing the window hides it rather than quitting, so the tray keeps the vault
  // running. Quitting goes through the tray menu or the key combination.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      // Nothing to do: the window is hidden, not closed.
    }
  });

  app.on("before-quit", stopServer);
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stopServer();
  });
}

// The renderer asks for the version it is running against, which the settings
// screen shows. Nothing else crosses this bridge.
ipcMain.handle("hasp:info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  origin: ORIGIN,
  vaultDir: VAULT_DIR,
}));

// The same round, reachable from the renderer. The panel calls the HTTP route
// directly, so this exists for a shell that is showing its own chrome later.
ipcMain.handle("hasp:sync-round", () => runSyncRound());
