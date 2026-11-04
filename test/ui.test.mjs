// Interface tests.
//
// These run the real client bundle (app.js, appearance.js, icons.js) inside
// jsdom against the real server. Nothing is stubbed except the browser itself,
// so a broken render, a broken selector or a broken fetch shows up here rather
// than in a screenshot someone forgets to take.
//
// What this cannot check: whether it looks good. That is what the PNG captures
// in docs/screens are for.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

/**
 * jsdom runs scripts but cannot import ES modules over HTTP, so modules are
 * fetched by this test and evaluated in the window in dependency order. The
 * source that runs is byte for byte the file the server serves.
 */
function bundle() {
  const appearance = readFileSync(join(WEB, "appearance.js"), "utf8");
  const icons = readFileSync(join(WEB, "icons.js"), "utf8");
  const app = readFileSync(join(WEB, "app.js"), "utf8");
  const strip = (src) => src.replace(/^import[^;]+;$/gm, "").replace(/^export /gm, "");
  return [
    strip(appearance),
    strip(icons),
    strip(app),
    "window.__app = { boot, state, render, refresh };",
  ].join("\n;\n");
}
const BUNDLE = bundle();

let server;
let base;
let dom;
let window;
let document;
let cookieJar = "";

/** Serve the page over real HTTP so fetch, cookies and modules all behave. */
async function startServer() {
  server = spawn(process.execPath, ["server.mjs", "--port=3922"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HASP_EPHEMERAL: "1", PORT: "3922" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = "http://127.0.0.1:3922";
  const lines = [];
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (c) => lines.push(c));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (lines.join("").includes("Hasp on")) return;
    if (server.exitCode !== null) throw new Error(`server exited: ${lines.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

/** Open the app in jsdom, with module loading and fetch wired to the server. */
async function open() {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    if (!/Could not load/.test(String(e.message))) throw e;
  });
  dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: base + "/",
    runScripts: "dangerously",
    resources: undefined,
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  window = dom.window;
  document = window.document;

  // jsdom has no fetch that carries the cookie jar, so wire one to the server.
  window.fetch = async (path, options = {}) => {
    const url = String(path).startsWith("http") ? String(path) : base + String(path);
    const headers = { ...(options.headers || {}) };
    if (cookieJar) headers.cookie = cookieJar;
    const res = await fetch(url, { ...options, headers });
    const set = res.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0];
      cookieJar = pair.endsWith("=") ? "" : pair;
    }
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      headers: { get: (k) => res.headers.get(k) },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };

  // jsdom has no clipboard by default; record what would be copied.
  window.__copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    value: {
      writeText: async (t) => window.__copied.push(t),
      readText: async () => window.__copied.at(-1) || "",
    },
    configurable: true,
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  // jsdom ships no WebCrypto. Lend it the real one, so the code path that runs
  // here is the same one a browser runs, not a stub of our own making.
  if (!window.crypto?.subtle) {
    const { webcrypto } = await import("node:crypto");
    Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
  }

  // Feed the real source to the real engine.
  try {
    window.eval(BUNDLE);
    await window.__app.boot();
  } catch (e) {
    window.__bootError = e;
  }
  await settle(6);
  if (window.__bootError) throw window.__bootError;
  return window.__app;
}

/** Let queued microtasks and timers run. */
async function settle(rounds = 6, ms = 15) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, ms));
    await Promise.resolve();
  }
}

/**
 * Wait for a condition, up to a limit. The unlock runs a real scrypt derivation,
 * which is not instant, so a fixed sleep is the wrong tool.
 */
async function until(check, { timeout = 15000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  await startServer();
});

after(async () => {
  dom?.window.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

describe("appearance", () => {
  test("resolve falls back to Nightshift, with the mode the system asks for", async () => {
    const { resolve, DEFAULT_DIRECTION } = await import("../src/web/appearance.js");
    const map = new Map();
    const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    assert.equal(DEFAULT_DIRECTION, "nightshift", "Nightshift is the surface the product leads with");
    assert.deepEqual(resolve(store, { prefersDark: false }), { dir: "nightshift", mode: "light", stored: false });
    assert.deepEqual(resolve(store, { prefersDark: true }), { dir: "nightshift", mode: "dark", stored: false });
  });

  test("the shell and the resolver agree on the default", async () => {
    // index.html paints the surface before the module runs, from an inline copy of
    // this logic. If the two ever disagree, a first visit flashes the wrong surface.
    const { DEFAULT_DIRECTION } = await import("../src/web/appearance.js");
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    assert.match(html, new RegExp(`dir = d === "foundry" \\|\\| d === "nightshift" \\? d : "${DEFAULT_DIRECTION}"`));
    assert.match(html, /<html lang="en" data-dir="nightshift"/);
  });

  test("a stored choice wins over the system preference", async () => {
    const { resolve } = await import("../src/web/appearance.js");
    const map = new Map([
      ["hasp.direction", "nightshift"],
      ["hasp.mode", "light"],
    ]);
    const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    assert.deepEqual(resolve(store, { prefersDark: true }), { dir: "nightshift", mode: "light", stored: true });
  });

  test("rubbish in storage is ignored, not trusted", async () => {
    const { resolve } = await import("../src/web/appearance.js");
    const map = new Map([
      ["hasp.direction", "<script>"],
      ["hasp.mode", "sepia"],
    ]);
    const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    assert.deepEqual(resolve(store, { prefersDark: false }), { dir: "nightshift", mode: "light", stored: false });
  });

  test("a blocked storage throws nothing", async () => {
    const { resolve, choose } = await import("../src/web/appearance.js");
    const store = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(resolve(store, { prefersDark: false }), { dir: "nightshift", mode: "light", stored: false });
    assert.doesNotThrow(() => choose(store, { dir: "foundry", mode: "dark" }));
  });

  test("attributes produce the pair the stylesheet reads", async () => {
    const { attributes } = await import("../src/web/appearance.js");
    assert.deepEqual(attributes({ dir: "nightshift", mode: "dark" }), {
      "data-dir": "nightshift",
      "data-mode": "dark",
    });
  });
});

describe("gate", () => {
  test("the unlock screen renders with the sample password filled in", async () => {
    await open();
    const html = document.getElementById("app").innerHTML;
    assert.match(html, /Unlock the vault/);
    assert.match(html, /Sample vault/);
    const input = document.querySelector("#master");
    assert.ok(input, "there is a password field");
    assert.equal(input.type, "password");
    assert.equal(input.value, "foundry-nightshift-2026", "a sample build fills its own fixture");
  });

  test("a wrong password shows an error and keeps the gate open", async () => {
    await open();
    const input = document.querySelector("#master");
    input.value = "wrong";
    document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => /Wrong master password/.test(document.getElementById("app").innerHTML), {
      label: "the error to render",
    });
    assert.ok(document.querySelector("#master"), "still on the gate");
  });

  test("the right password opens the vault", async () => {
    const input = document.querySelector("#master");
    input.value = "foundry-nightshift-2026";
    document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => document.querySelector(".rail"), { label: "the shell to render" });
    const html = document.getElementById("app").innerHTML;
    assert.match(html, /class="rail"/, "the shell rendered");
    assert.match(html, /Groq production/);
  });
});

describe("vault view", () => {
  before(async () => {
    if (!document?.querySelector(".rail")) {
      await open();
      const input = document.querySelector("#master");
      if (input) {
        input.value = "foundry-nightshift-2026";
        document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
        await until(() => document.querySelector(".rail"), { label: "the shell to render" });
      }
    }
  });

  test("the seeded items are listed with environment tags and types", () => {
    const rows = document.querySelectorAll(".row");
    assert.ok(rows.length >= 14, `expected the sample set, got ${rows.length}`);
    const text = document.querySelector(".list").textContent;
    for (const name of ["Groq production", "Stripe secret key", "GitHub recovery codes", "GitHub 2FA", "AWS root 2FA"]) {
      assert.ok(text.includes(name), name);
    }
    assert.equal(document.querySelectorAll(".tag").length > 0, true);
  });

  test("the inspector shows the selected item, masked, with copy and reveal", async () => {
    const rows = [...document.querySelectorAll(".row")];
    const apiKeyRow = rows.find((r) => r.textContent.includes("Groq production"));
    apiKeyRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const inspector = document.querySelector(".inspector");
    assert.ok(inspector);
    assert.match(inspector.textContent, /Groq production/);
    const code = inspector.querySelector("[data-secret]");
    assert.ok(code, "a secret block");
    assert.match(code.innerHTML, /•/, "the value is masked by default");
    assert.ok(inspector.querySelector("[data-copy]"));
    assert.ok(inspector.querySelector("[data-reveal]"));
  });

  test("a brand mark is served for a known item", () => {
    const img = document.querySelector(".tile img");
    assert.ok(img);
    assert.match(img.getAttribute("src"), /^brands\/.+\.svg$/);
  });

  test("the list header carries the four columns", () => {
    const head = document.querySelector(".list-head");
    assert.match(head.textContent, /Item/);
    assert.match(head.textContent, /Environment/);
    assert.match(head.textContent, /Type/);
    assert.match(head.textContent, /Last used/);
  });

  test("every item explains why it is suggested", () => {
    const why = document.querySelector(".why p");
    assert.ok(why, "the inspector carries a reason line");
    assert.ok(why.textContent.trim().length > 12);
  });

  test("clicking a row selects it", async () => {
    const rows = [...document.querySelectorAll(".row")];
    const target = rows.find((r) => r.textContent.includes("Stripe secret key"));
    const id = target.dataset.id;
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.match(document.querySelector(".inspector").textContent, /Stripe secret key/);
    const selected = document.querySelectorAll('.row[aria-selected="true"]');
    assert.equal(selected.length, 1, "exactly one row is selected");
    assert.equal(selected[0].dataset.id, id);
  });

  test("reveal shows the value and hides it again", async () => {
    document.querySelector("[data-reveal]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.ok(document.querySelector("[data-secret]").textContent.includes("EXAMPLE-stripe"), "revealed");
    document.querySelector("[data-reveal]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.match(document.querySelector("[data-secret]").innerHTML, /•/, "hidden again");
  });

  test("copy puts the value on the clipboard", async () => {
    document.querySelector("[data-copy]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(6);
    assert.ok(window.__copied.some((v) => v.startsWith("EXAMPLE-stripe")), "the secret reached the clipboard, not the DOM");
  });

  test("a one-time code item renders a live code and a meter", async () => {
    const rows = [...document.querySelectorAll(".row")];
    rows.find((r) => r.textContent.includes("GitHub 2FA")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(6);
    const code = document.querySelector("[data-totp]");
    assert.ok(code, "a live code block");
    assert.match(code.textContent.replace(/\s/g, ""), /^\d{6}$/);
    assert.ok(document.querySelector("[data-meter]"), "the depletion meter");
  });

  test("a backup code set shows the unused count and never the whole set at once", async () => {
    const rows = [...document.querySelectorAll(".row")];
    rows.find((r) => r.textContent.includes("GitHub recovery codes")).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(4);
    const inspector = document.querySelector(".inspector");
    assert.match(inspector.textContent, /8 of 10 unused/);
    assert.equal(inspector.querySelectorAll(".code-row").length, 10);
    assert.equal(inspector.querySelectorAll(".code-row.is-used").length, 2);
    // Copying a single code is offered per row; there is no copy-all.
    assert.equal(inspector.querySelectorAll("[data-copy-code]").length, 10);
    assert.equal(inspector.querySelector("[data-copy-all]"), null);
  });
});

describe("search and filters", () => {
  test("typing filters the list without a request", async () => {
    const search = document.querySelector("[data-search]");
    search.value = "stripe";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    const names = [...document.querySelectorAll(".row .row-name")].map((n) => n.textContent);
    assert.equal(names.length, 1);
    assert.match(names[0], /Stripe/);
  });

  test("a query with no match says so rather than showing an empty table", async () => {
    const search = document.querySelector("[data-search]");
    search.value = "zzzzz";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    assert.equal(document.querySelectorAll(".row").length, 0);
    assert.match(document.querySelector(".inspector").textContent, /No match/);
  });

  test("clearing the query restores the list", async () => {
    const search = document.querySelector("[data-search]");
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    assert.ok(document.querySelectorAll(".row").length >= 14);
  });

  test("a type chip filters", async () => {
    const chip = document.querySelector('[data-type="backup-codes"]');
    chip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const types = [...document.querySelectorAll(".row .rtype")].map((t) => t.textContent);
    assert.ok(types.length > 0);
    assert.equal(new Set(types).size, 1);
    assert.equal(types[0], "Backup codes");
    // Put it back.
    document.querySelector('[data-type="all"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
  });

  test("the environment chip cycles through every value including none", async () => {
    const chip = document.querySelector("[data-env-cycle]");
    assert.match(chip.textContent, /all/);
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      document.querySelector("[data-env-cycle]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(2);
      seen.add(document.querySelector("[data-env-cycle]").textContent.trim());
    }
    assert.ok(seen.size >= 5, `expected the cycle to visit each value, saw ${[...seen].join(" | ")}`);
  });
});

describe("the two directions and their two modes", () => {
  test("the switcher offers both directions and both modes", () => {
    const dirButtons = [...document.querySelectorAll("[data-dir-switch]")];
    const modeButtons = [...document.querySelectorAll("[data-mode-switch]")];
    assert.deepEqual(dirButtons.map((b) => b.dataset.dirSwitch).sort(), ["foundry", "nightshift"]);
    assert.deepEqual(modeButtons.map((b) => b.dataset.modeSwitch).sort(), ["dark", "light"]);
  });

  test("all four combinations can be selected and are written to the document", async () => {
    for (const dir of ["foundry", "nightshift"]) {
      for (const mode of ["light", "dark"]) {
        document.querySelector(`[data-dir-switch="${dir}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settle(2);
        document.querySelector(`[data-mode-switch="${mode}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settle(2);
        assert.equal(document.documentElement.dataset.dir, dir);
        assert.equal(document.documentElement.dataset.mode, mode);
        // The pressed state follows.
        assert.equal(document.querySelector(`[data-dir-switch="${dir}"]`).getAttribute("aria-pressed"), "true");
        assert.equal(document.querySelector(`[data-mode-switch="${mode}"]`).getAttribute("aria-pressed"), "true");
      }
    }
  });

  test("the choice is remembered for the next visit", () => {
    assert.equal(window.localStorage.getItem("hasp.direction"), "nightshift");
    assert.equal(window.localStorage.getItem("hasp.mode"), "dark");
  });

  test("switching surfaces keeps the vault intact", async () => {
    const before = [...document.querySelectorAll(".row .row-name")].map((n) => n.textContent);
    for (const dir of ["foundry", "nightshift", "foundry"]) {
      document.querySelector(`[data-dir-switch="${dir}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(2);
    }
    const after = [...document.querySelectorAll(".row .row-name")].map((n) => n.textContent);
    assert.deepEqual(after, before, "the same items, in the same order");
    assert.equal(document.querySelectorAll('.row[aria-selected="true"]').length, 1, "the selection survives");
  });
});

describe("other views", () => {
  for (const [view, expected] of [
    ["import", /Bring in what you already have/],
    ["activity", /Recent activity/],
    ["devices", /Devices/],
    ["settings", /Appearance/],
  ]) {
    test(`the ${view} view renders`, async () => {
      document.querySelector(`[data-view="${view}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(3);
      assert.match(document.getElementById("app").textContent, expected);
    });
  }

  test("settings states what the build does not do", async () => {
    document.querySelector('[data-view="settings"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    const text = document.getElementById("app").textContent;
    assert.match(text, /Not audited/);
    assert.match(text, /independent cryptographic review/i);
  });

  test("the import view accepts a paste and renders a review", async () => {
    document.querySelector('[data-view="import"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    const box = document.querySelector("#paste");
    assert.ok(box, "a paste area");
    box.value = "otpauth://totp/Acme:dev@acme.test?secret=GEZDGNBVGY3TQOJQ&issuer=Acme";
    document.querySelector("[data-parse-paste]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(8);
    assert.match(document.getElementById("app").textContent, /Import review/);
    assert.match(document.getElementById("app").textContent, /Acme/);
  });

  test("back to the vault, the list is still there", async () => {
    document.querySelector('[data-view="vault"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    assert.ok(document.querySelectorAll(".row").length >= 14);
  });
});

describe("the editor", () => {
  test("add item opens a dialog with the expected fields", async () => {
    document.querySelector("[data-add]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    const modal = document.querySelector(".modal");
    assert.ok(modal);
    assert.equal(modal.getAttribute("role"), "dialog");
    assert.equal(modal.getAttribute("aria-modal"), "true");
    for (const id of ["#f-name", "#f-type", "#f-env", "#f-value", "#f-host", "#f-notes"]) {
      assert.ok(modal.querySelector(id), id);
    }
    document.querySelector("[data-close]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(2);
    assert.equal(document.querySelector(".modal"), null);
  });

  test("submitting without a name is refused in the page, not the server", async () => {
    document.querySelector("[data-add]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    const form = document.querySelector(".modal form");
    document.querySelector("#f-name").value = "";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await settle(3);
    assert.match(document.querySelector("[data-error]").textContent, /name/i);
    document.querySelector("[data-close]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(2);
  });

  test("a new item is added and appears in the list", async () => {
    document.querySelector("[data-add]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    document.querySelector("#f-name").value = "Added in the interface test";
    document.querySelector("#f-value").value = "gsk_prod_invented_for_the_ui_test";
    document.querySelector("#f-env").value = "staging";
    document.querySelector(".modal form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await settle(10);
    assert.equal(document.querySelector(".modal"), null, "the dialog closed");
    assert.match(document.querySelector(".list").textContent, /Added in the interface test/);
  });
});

describe("the four surfaces page", () => {
  test("renders all four combinations from the real components", async () => {
    const html = readFileSync(join(WEB, "themes.html"), "utf8");
    const page = new JSDOM(html, { url: base + "/themes.html", runScripts: "outside-only", pretendToBeVisual: true });
    const pw = page.window;
    pw.matchMedia = () => ({ matches: false });
    const strip = (src) => src.replace(/^import[^;]+;$/gm, "").replace(/^export /gm, "");
    pw.eval(strip(readFileSync(join(WEB, "icons.js"), "utf8")) + "\n;\n" + strip(readFileSync(join(WEB, "themes.js"), "utf8")));
    await new Promise((r) => setTimeout(r, 40));

    const frames = [...pw.document.querySelectorAll(".frame")];
    assert.equal(frames.length, 4, "one frame per combination");
    const combos = frames.map((f) => `${f.dataset.dir}/${f.dataset.mode}`).sort();
    assert.deepEqual(combos, ["foundry/dark", "foundry/light", "nightshift/dark", "nightshift/light"]);

    for (const frame of frames) {
      // Each frame carries its own tokens, so it is independent of the page.
      assert.ok(frame.dataset.dir && frame.dataset.mode);
      assert.equal(frame.querySelectorAll(".row").length, 7, "seven sample rows");
      assert.ok(frame.querySelector(".inspector"), "an inspector");
      assert.ok(frame.querySelector(".totp-card"), "a one-time code block");
      assert.ok(frame.querySelector(".seg"), "the switch");
      // Brand marks are real files, not placeholder letters.
      assert.ok(frame.querySelectorAll(".tile img").length >= 7);
    }
    pw.close();
  });
});
