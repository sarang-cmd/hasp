// Tests for the desktop shell.
//
// Electron cannot be launched here, and pretending a test covers the window would
// be worse than admitting it does not. What can be tested is the part that decides
// whether the shell is safe: what the renderer is allowed to reach, and what the
// main process refuses to navigate to.
//
// The security settings are read from the source and checked against an explicit
// expectation, so turning one of them off fails the build rather than quietly
// widening what a compromised page can do.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");
const main = readFileSync(join(DESKTOP, "main.js"), "utf8");
const preload = readFileSync(join(DESKTOP, "preload.js"), "utf8");

describe("main process", () => {
  test("the renderer gets no node and an isolated context", () => {
    assert.match(main, /nodeIntegration:\s*false/, "node integration is on");
    assert.match(main, /contextIsolation:\s*true/, "context isolation is off");
    assert.match(main, /sandbox:\s*true/, "the sandbox is off");
  });

  test("no remote module and no insecure web security flag", () => {
    assert.ok(!/enableRemoteModule/.test(main), "the remote module is enabled");
    assert.ok(!/webSecurity:\s*false/.test(main), "web security is disabled");
    assert.ok(!/allowRunningInsecureContent/.test(main));
  });

  test("a window is never opened for an external url", () => {
    // setWindowOpenHandler must deny, and the only thing it may do with a link is
    // hand an http or https url to the operating system.
    const handler = /setWindowOpenHandler\([^)]*\)[\s\S]{0,400}?\}\);/.exec(main);
    assert.ok(handler, "there is no window open handler");
    assert.match(handler[0], /action:\s*"deny"/, "a new window is allowed");
    assert.match(handler[0], /\^https\?:\\\/\\\//, "the url is not checked before it is opened");
  });

  test("navigation away from the vault origin is prevented", () => {
    const nav = /will-navigate[\s\S]{0,400}?\);/.exec(main);
    assert.ok(nav, "there is no navigation guard");
    assert.match(nav[0], /preventDefault\(\)/, "navigation is not cancelled");
    assert.match(nav[0], /startsWith\(ORIGIN\)/, "the origin is not checked");
  });

  test("the webview tag is refused", () => {
    assert.match(main, /will-attach-webview/, "a webview can be attached");
  });

  test("the server is spawned, not imported into the main process", () => {
    // Importing it would let a server bug take the window down with it, and the
    // server owns process.exit.
    assert.ok(!/import\(.*server\.mjs/.test(main), "the server is imported");
    assert.match(main, /spawn\(/, "the server is not spawned");
    assert.match(main, /ELECTRON_RUN_AS_NODE/, "the child would try to open a window");
  });

  test("the vault directory is outside the install directory when packaged", () => {
    assert.match(main, /app\.isPackaged/, "packaged and development are not distinguished");
    assert.match(main, /getPath\("userData"\)/, "the packaged vault is not in user data");
  });

  test("only one instance may run", () => {
    // Two processes writing one vault file is a corruption the schema does not
    // prevent, so a second launch has to hand over to the first.
    assert.match(main, /requestSingleInstanceLock/);
    assert.match(main, /second-instance/);
  });

  test("the server is stopped on quit", () => {
    assert.match(main, /before-quit[\s\S]{0,80}stopServer/);
    assert.match(main, /SIGTERM/);
  });

  test("shortcuts are released on quit", () => {
    assert.match(main, /unregisterAll/);
  });
});

describe("preload bridge", () => {
  test("exposes a named list of things and no more", () => {
    // The list is written out rather than counted, so adding to the bridge is a
    // decision someone made in this file and not something that happened by accident.
    const exposed = [...preload.matchAll(/contextBridge\.exposeInMainWorld\("(\w+)",\s*\{([\s\S]*?)\n\}\);/g)];
    assert.equal(exposed.length, 1, "more than one bridge");
    assert.equal(exposed[0][1], "haspDesktop");
    const keys = [...exposed[0][2].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), ["info", "isDesktop", "onNotice", "onVaultEvent", "syncRound"]);
  });

  test("every round outcome has its own sentence", () => {
    // The function is lifted out of the source and evaluated, because requiring the
    // file outside Electron throws at the first line that asks for an app. That makes
    // this a real execution rather than a search for strings.
    const body = /function describeRound\(status, body\) \{([\s\S]*?)\n\}/.exec(main);
    assert.ok(body, "describeRound is in the shell");
    const describeRound = new Function("status", "body", body[1]);

    assert.equal(describeRound(401, {}).text, "The vault is locked. Unlock it to sync.");
    assert.equal(describeRound(423, {}).text, "The vault is locked. Unlock it to sync.");
    assert.equal(describeRound(409, {}).text, "Sync is off for this vault.");
    assert.match(describeRound(500, { error: "Something went wrong" }).text, /Something went wrong/);
    assert.match(describeRound(500, {}).text, /answered 500/);

    // A conflict is reported as a decision, and counted in the singular properly.
    const one = describeRound(200, { pushed: 0, pulled: { applied: 0 }, conflicts: [{ id: "a" }] });
    assert.equal(one.ok, false, "a conflict is not a success");
    assert.match(one.text, /^1 item changed/, one.text);
    assert.equal(one.conflicts, 1);
    const two = describeRound(200, { pushed: 0, pulled: { applied: 0 }, conflicts: [{ id: "a" }, { id: "b" }] });
    assert.match(two.text, /^2 items changed/, two.text);

    // Quiet, and work, and both say what moved.
    assert.equal(describeRound(200, { pushed: 0, pulled: { applied: 0 }, conflicts: [] }).text, "Already up to date.");
    const busy = describeRound(200, { pushed: 2, pulled: { applied: 3 }, conflicts: [] });
    assert.equal(busy.ok, true);
    assert.equal(busy.text, "3 in, 2 out.");
    // A reply with nothing in it must not read as a crash.
    assert.equal(describeRound(200, {}).text, "Already up to date.");
  });

  test("a tray sync reports through the tooltip and the window", () => {
    assert.match(main, /label: "Sync now"/);
    assert.match(main, /setToolTip\(`Hasp\. \$\{result\.text\}`\)/);
    assert.match(main, /report\(mainWindow, result\.text\)/);
  });

  test("a sync round through the bridge returns a sentence, not a vault", () => {
    // The renderer can already fetch the vault over loopback. What it must not gain is
    // a privileged path to item data, so the round reports text and nothing else.
    const main = readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
    const handler = /ipcMain\.handle\("hasp:sync-round",([\s\S]*?)\);\n/.exec(main);
    assert.ok(handler, "the round handler is registered");
    const body = handler[1];
    assert.match(body, /runSyncRound\(\)/, "it calls the one implementation");
    const fn = /async function runSyncRound\(\)([\s\S]*?)\n\}/.exec(main);
    assert.ok(fn, "the round has a body");
    // Every branch returns { ok, text }. None returns items.
    assert.equal(/return\s*\{[^}]*\bitems\b/.test(fn[1]), false, "the round returns item data");
    assert.match(fn[1], /text:/);
  });

  test("the bridge cannot reach the vault", () => {
    // There is no reason for privileged code to read the vault, so there is no
    // function that does. The page uses fetch over loopback like a browser tab.
    for (const forbidden of ["items", "state", "unlock", "secret", "read", "exec", "run"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\s*:`).test(preload.split("contextBridge")[1] || ""), `${forbidden} is exposed`);
    }
  });

  test("the listener can be removed, so a re-render does not stack handlers", () => {
    assert.match(preload, /removeListener/);
    assert.match(preload, /return \(\) =>/);
  });

  test("requires nothing but electron", () => {
    // A sandboxed preload cannot require node modules, so a require of fs or
    // child_process here would fail at runtime rather than in review.
    const requires = [...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, ["electron"]);
  });
});

describe("packaging", () => {
  test("the package points at the shell", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.main, "desktop/main.js");
    assert.equal(pkg.scripts.desktop, "electron .");
  });

  test("the files the shell names exist", () => {
    for (const file of ["main.js", "preload.js", "README.md", "icons/tray.png", "icons/icon.png"]) {
      assert.ok(existsSync(join(DESKTOP, file)), `missing: ${file}`);
    }
  });

  test("the tray icon is a real png, not an empty file", () => {
    const icon = readFileSync(join(DESKTOP, "icons/tray.png"));
    assert.equal(icon.subarray(1, 4).toString(), "PNG", "the tray icon is not a png");
    assert.ok(icon.length > 100, "the tray icon is empty");
  });

  test("electron is not a runtime dependency of the server", () => {
    // The server must keep running under plain node. An electron import anywhere
    // outside desktop/ would break the command line build.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.dependencies?.electron, undefined);
  });
});
