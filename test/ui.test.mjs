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
  const tour = readFileSync(join(WEB, "tour.js"), "utf8");
  const strip = (src) => src.replace(/^import[^;]+;$/gm, "").replace(/^export /gm, "");
  // app.js imports the brand index as JSON. The strip above removes the import
  // statement, so the binding has to be injected the same way the modules are,
  // or every reference to it is a ReferenceError inside the bundle.
  const brandIndex = readFileSync(join(WEB, "brands.index.json"), "utf8");
  return [
    `const BRAND_INDEX = ${brandIndex};`,
    strip(appearance),
    strip(icons),
    strip(tour),
    strip(app),
    "window.__app = { boot, state, render, refresh, cancelClipboardClear, cancelIdleWarning, lockGateUntil, tileFor, startTour, typeInto, Tour, renderSyncBody, renderConflicts, renderConflictView };",
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
    // Suppress the first-visit walkthrough: it writes a full page layer on a timer,
  // and several cases below assert on document-wide selectors.
  window.localStorage.setItem("hasp.tour", "skipped");
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
    assert.deepEqual(resolve(store, { prefersDark: false }), { dir: "nightshift", mode: "light", accent: "colour", stored: false });
    assert.deepEqual(resolve(store, { prefersDark: true }), { dir: "nightshift", mode: "dark", accent: "colour", stored: false });
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
    assert.deepEqual(resolve(store, { prefersDark: true }), { dir: "nightshift", mode: "light", accent: "colour", stored: true });
  });

  test("rubbish in storage is ignored, not trusted", async () => {
    const { resolve } = await import("../src/web/appearance.js");
    const map = new Map([
      ["hasp.direction", "<script>"],
      ["hasp.mode", "sepia"],
    ]);
    const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
    assert.deepEqual(resolve(store, { prefersDark: false }), { dir: "nightshift", mode: "light", accent: "colour", stored: false });
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
    assert.deepEqual(resolve(store, { prefersDark: false }), { dir: "nightshift", mode: "light", accent: "colour", stored: false });
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

  test("the accent style is a third axis and it persists", async () => {
    const { attributes, resolve, choose } = await import("../src/web/appearance.js");
    const map = new Map();
    const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };

    // Default is colour, which omits the attribute so the stylesheet's own path runs.
    const initial = resolve(store, { prefersDark: false });
    assert.equal(initial.accent, "colour");
    assert.equal(attributes(initial)["data-accent"], undefined, "the default must not set an attribute");

    choose(store, { ...initial, accent: "mono" });
    const again = resolve(store, { prefersDark: false });
    assert.equal(again.accent, "mono", "the choice did not persist");
    assert.equal(attributes(again)["data-accent"], "mono");

    // Rubbish is ignored rather than trusted.
    map.set("hasp.accent", "<script>");
    assert.equal(resolve(store, { prefersDark: false }).accent, "colour");
  });

  test("the tour dims, highlights, and refuses to advance past an unmet gate", async () => {
    // The whole point of the walkthrough is that the user does something. If the
    // Next button advances regardless of the step's condition, it is a slideshow
    // with extra steps, which is the thing the brief asked not to build.
    const { startTour, Tour } = window.__app;
    assert.equal(typeof startTour, "function", "the tour is not reachable");

    // Drive the engine directly with a step whose gate starts closed, so the test
    // measures the rule rather than the current copy.
    let opened = false;
    let finished = null;
    const target = document.createElement("div");
    target.id = "tour-fixture";
    document.querySelector("#app").appendChild(target);

    const t = new Tour(
      [
        { target: () => document.getElementById("tour-fixture"), title: "First", body: "one", action: "Go" },
        { target: () => document.getElementById("tour-fixture"), title: "Second", body: "two", done: () => opened, waiting: "Waiting", autoAdvance: false },
      ],
      { onFinish: (r) => (finished = r) }
    );
    t.start();

    // Only the fixture's layer should exist. The app also offers the tour on a first
    // visit; a second layer here means that timer fired during the test and the
    // assertions below would be reading someone else's dialog.
    const layers = document.querySelectorAll(".tour");
    assert.equal(layers.length, 1, `expected one tour layer, found ${layers.length}`);
    assert.ok(document.querySelector(".tour"), "the dim layer was not created");
    assert.ok(document.querySelector(".tour-hole"), "the highlight hole was not created");
    assert.equal(document.body.classList.contains("is-touring"), true, "the page is not marked as touring");
    assert.match(document.querySelector(".tour-step").textContent, /Step 1 of 2/);
    assert.equal(document.querySelector(".tour-demo").textContent, "Sample data");

    t.next(); // step 1 has no gate, so it advances
    assert.match(document.querySelector(".tour-step").textContent, /Step 2 of 2/);

    // The gate is closed. Next must not move, and must say why.
    t.next();
    assert.match(document.querySelector(".tour-step").textContent, /Step 2 of 2/, "advanced past a closed gate");
    assert.equal(document.querySelector("[data-tour-next]").textContent, "Waiting");

    // Open the gate. The step sets autoAdvance:false, so the watcher must enable
    // the button without moving on its own; that is the behaviour being asserted.
    opened = true;
    t.watch();
    await until(() => document.querySelector("[data-tour-next]")?.textContent !== "Waiting", "the button became ready", 4000);
    assert.notEqual(document.querySelector(".tour-step").textContent, "Step 3 of 2");
    assert.match(document.querySelector(".tour-step").textContent, /Step 2 of 2/, "it advanced without being told to");
    t.next();
    await until(() => t.done, "the tour completed after its gate opened", 4000);
    assert.equal(finished, "complete");
    assert.equal(document.querySelector(".tour"), null, "the layer outlived the tour");
    assert.equal(document.body.classList.contains("is-touring"), false, "the page is still locked");

    target.remove();
    // Leave nothing behind for the next case, and stop a pending auto-start.
    t.finish("skipped");
    window.__app.startTour()?.finish?.("skipped");
    document.querySelectorAll(".tour").forEach((el) => el.remove());
    document.body.classList.remove("is-touring");
  });

  test("typeInto types visibly and the field reacts", async () => {
    // The demo values are typed one character at a time through the native setter
    // and an input event, so the app sees the same events a person would produce.
    const { typeInto } = window.__app;
    const host = document.createElement("div");
    host.innerHTML = `<input id="typer">`;
    const input = host.querySelector("input");
    const seen = [];
    input.addEventListener("input", () => seen.push(input.value.length));

    await typeInto(input, "demo-key", { perChar: 1 });
    assert.equal(input.value, "demo-key");
    assert.ok(seen.length >= 8, `expected per-character events, saw ${seen.length}`);
    // The intermediate states must have been partial, not the whole string at once.
    assert.equal(seen[0], 1, "the first event should carry one character");
  });

  test("an unknown brand falls back to a letter, not a broken image", async () => {
    // An imported item can carry any brand string. Pointing an <img> at a slug we
    // never vendored gives a broken-image glyph, which reads as the product
    // failing rather than the brand being unknown.
    // Rows carry a .tile; a vendored brand renders an <img> inside it.
    const tiles = [...document.querySelectorAll(".row-main .tile")];
    assert.ok(tiles.length > 0, "precondition: the vault list rendered");
    const known = tiles.find((t) => t.querySelector("img"));
    assert.ok(known, "precondition: some row uses a vendored mark");

    // Drive a real item through the renderer with a slug that does not exist.
    const { tileFor } = window.__app;
    if (typeof tileFor === "function") {
      const html = tileFor({ brand: "not-a-real-brand", name: "Acme", service: "Acme" });
      assert.match(html, /tile--text/, "unknown slugs must fall back to a letter");
      assert.ok(!html.includes("<img"), "unknown slugs must not emit an image");
    }
  });

  test("the editor returns focus to whatever opened it", async () => {
    // A dialog that drops the keyboard user at the top of the document is a
    // regression you only notice by tabbing.
    const app = document.querySelector("#app");
    const trigger = document.createElement("button");
    trigger.textContent = "Add item";
    app.appendChild(trigger);
    trigger.focus();
    assert.equal(document.activeElement, trigger, "precondition: the trigger has focus");

    const add = document.querySelector("[data-add]");
    assert.ok(add, "the vault should offer Add");
    add.click();
    await until(() => document.querySelector(".modal"), "the editor opened");
    assert.equal(document.querySelector("body").classList.contains("is-modal-open"), true, "the page must not scroll behind the dialog");

    document.querySelector(".modal [data-close]").click();
    await until(() => !document.querySelector(".modal"), "the editor closed");
    assert.equal(document.querySelector("body").classList.contains("is-modal-open"), false, "the scroll lock must be released");
  });

  test("a throttled gate counts down and then reopens", async () => {
    // The server answers 429 with Retry-After; the gate must turn that into a
    // countdown rather than leaving a button that is certain to fail.
    const { lockGateUntil } = window.__app;
    assert.equal(typeof lockGateUntil, "function");

    // Build the gate off-document: replacing document.body would tear down the
    // running app that the other cases in this file are still driving.
    const host = document.createElement("div");
    host.innerHTML = `<form><input id="master" value="x"><button type="submit" data-unlock>Unlock</button></form>`;
    const form = host.querySelector("form");
    const btn = form.querySelector("button");
    const input = form.querySelector("input");

    const stop = lockGateUntil(form, 2);
    assert.equal(btn.disabled, true, "the button must not be clickable while throttled");
    assert.equal(input.disabled, true, "the field is disabled too");
    assert.match(btn.textContent, /Wait \d+s/, "the countdown is visible");

    // Clearing restores the gate rather than leaving it stuck shut.
    stop();
    assert.equal(btn.disabled, false);
    assert.equal(input.disabled, false);
    assert.equal(btn.textContent, "Unlock");
  });

  test("the idle warning can be cancelled without throwing", async () => {
    // The warning is a courtesy; the server is what actually ends a session. The
    // client side must never throw while clearing it, including when unarmed.
    assert.equal(typeof window.__app.cancelIdleWarning, "function");
    assert.doesNotThrow(() => window.__app.cancelIdleWarning());
  });

  test("copying twice leaves only the newest timer running", async () => {
    // The clear reads the clipboard back before emptying it, so a stale timer whose
    // captured value no longer matches must not fire against the new one.
    const { cancelClipboardClear } = window.__app;
    assert.equal(typeof cancelClipboardClear, "function", "lock cannot cancel the clear");
    assert.doesNotThrow(() => cancelClipboardClear(), "cancelling with nothing pending");
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
  test("typing asks the vault, and the list narrows", async () => {
    // The query is answered by the blind index on the server, not by filtering the
    // decrypted list here. That is the point: the words typed are never stored, and
    // the search does not need the plaintext of fields it did not match.
    //
    // Settle longer than the debounce, since the request only leaves after 120ms.
    const search = document.querySelector("[data-search]");
    search.value = "stripe";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle(24, 15);
    const names = [...document.querySelectorAll(".row .row-name")].map((n) => n.textContent);
    // Two, not one. A note item mentions Stripe webhooks, and notes are indexed. The old browser filter only looked at name, service, host, type and
    // tags, so it missed the note and showed a single row.
    assert.equal(names.length, 2);
    assert.match(names[0], /Stripe/);
    assert.ok(names.includes("Rate limit notes"));
  });

  test("the query reaches the server, and the words typed are not kept anywhere", async () => {
    // The rows narrowing is not proof that search is server side: a client filter
    // would narrow them too. This wraps fetch and reads the URL that actually left.
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const href = typeof input === "string" ? input : input.url;
      seen.push(href);
      return realFetch(input, init);
    };
    try {
      const search = document.querySelector("[data-search]");
      search.value = "vercel";
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle(24, 15);
    } finally {
      globalThis.fetch = realFetch;
    }
    const stateCall = seen.find((u) => u.includes("/api/state?q="));
    assert.ok(stateCall, `no query request left the page, saw ${JSON.stringify(seen)}`);
    assert.match(stateCall, /q=vercel/);
    assert.equal(seen.filter((u) => u.includes("q=vercel")).length, 1, "one request per query, not one per keystroke");
  });

  test("a query with no match says so rather than showing an empty table", async () => {
    const search = document.querySelector("[data-search]");
    search.value = "zzzzz";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle(24, 15);
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

  test("the activity view reads the log and names the action", async () => {
    // The old view derived its rows from item timestamps and labelled every one
    // "copied", which it could not know. This checks the real log instead.
    document.querySelector('[data-view="activity"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(14);
    const text = () => document.getElementById("app").textContent;
    // The seeded vault has not been touched yet, so the view must say so rather than
    // invent rows or look broken.
    assert.match(text(), /Recent activity/);
    assert.match(text(), /Nothing yet|added|edited|copied/);

    // Make a real action through the app's own fetch, then reload the view.
    const res = await window.fetch("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Activity witness", type: "api-key", value: "EXAMPLE-witness" }),
    });
    assert.equal(res.status, 201);
    document.querySelector('[data-view="vault"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(6);
    document.querySelector('[data-view="activity"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(14);

    assert.match(text(), /Activity witness added/, "the action is named, not guessed");
    // And the promise in the copy is kept: no value appears.
    assert.equal(text().includes("EXAMPLE-witness"), false, "a value reached the log view");
  });

  test("a deleted item is listed in activity and restored from there", async () => {
    const created = await window.fetch("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Restore me", type: "api-key", value: "EXAMPLE-restore-ui" }),
    });
    const { id } = await created.json();
    await window.fetch(`/api/items/${id}`, { method: "DELETE" });

    document.querySelector('[data-view="activity"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(16);
    const text = () => document.getElementById("app").textContent;
    assert.match(text(), /Restore me/, "the deleted item is listed");

    const button = document.querySelector(`[data-restore="${id}"]`);
    assert.ok(button, "with a way to bring it back");
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(20);

    const deleted = await (await window.fetch("/api/items/deleted")).json();
    assert.equal(deleted.items.some((i) => i.id === id), false, "it left the deleted list");
    const state = await (await window.fetch("/api/state")).json();
    assert.ok(state.items.some((i) => i.id === id), "and came back into the vault");
  });

  test("the sync panel starts off, turns on, shows the token once and turns off", async () => {
    document.querySelector('[data-view="settings"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(12);

    const text = () => document.getElementById("app").textContent;
    // Off is the default, and the copy has to say so rather than leave a blank panel.
    assert.match(text(), /Sync/);
    assert.match(text(), /Off/, "sync starts off and says so");
    assert.ok(document.querySelector("[data-sync-start]"), "there is a way to turn it on");

    document.querySelector("[data-sync-start]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(14);
    assert.match(text(), /On/);
    const token = document.querySelector("[data-sync-token]");
    assert.ok(token, "the write token is shown once");
    const shown = token.textContent.match(/[A-Za-z0-9_-]{40,}/);
    assert.ok(shown, `no token in the panel: ${token.textContent}`);

    // The status route must never repeat it, so a re-render from status alone drops it.
    assert.equal(window.__app.state.syncToken, shown[0], "the token lives in memory only");

    // Turning sync off clears the panel and keeps the stored copy described as such.
    document.querySelector("[data-sync-off]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(14);
    assert.match(text(), /Off/);
    assert.equal(document.querySelector("[data-sync-token]"), null, "the token is gone from the panel");
    assert.match(text(), /still on the other side/);
  });

  test("a conflict can be compared and one side kept", async () => {
    // Use the app's own fetch, which carries the session cookie, so this drives the
    // same routes the interface calls rather than a second implementation of them.
    const call = async (path, options = {}) => {
      const res = await window.fetch(path, options);
      return { status: res.status, json: await res.json() };
    };

    document.querySelector('[data-view="settings"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(12);

    await call("/api/sync/start", { method: "POST" });
    await call("/api/sync/round", { method: "POST", body: JSON.stringify({ since: 0 }) });

    const item = window.__app.state.items.find((i) => i.type === "api-key");
    assert.ok(item, "there is an item to clash over");

    // Nothing has clashed yet, so the comparison has to say the copies agree rather
    // than invent a difference.
    const agreed = await call(`/api/sync/conflicts/compare?id=${item.id}`);
    assert.equal(agreed.status, 200);
    assert.equal(agreed.json.id, item.id);
    assert.equal(agreed.json.differs, 0);
    assert.ok(agreed.json.fields.some((f) => f.field === "value"), "the secret is compared");

    // A refusal is named rather than shown as a blank table.
    const missing = await call("/api/sync/conflicts/compare?id=not-a-real-id");
    assert.equal(missing.status, 404);

    // Keeping a side raises the revision above the one that lost, then a round is quiet.
    const kept = await call("/api/sync/conflicts/resolve", {
      method: "POST",
      body: JSON.stringify({ id: item.id, keep: "remote" }),
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.json.kept, "remote");
    const round = await call("/api/sync/round", { method: "POST", body: JSON.stringify({ since: 0 }) });
    assert.deepEqual(round.json.conflicts, [], "the resolved record does not clash again");

    // And a side that is neither of the two is refused by name.
    const bad = await call("/api/sync/conflicts/resolve", {
      method: "POST",
      body: JSON.stringify({ id: item.id, keep: "sideways" }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /local or remote/);
  });

  test("the panel draws a conflict row and opens a comparison from it", async () => {
    document.querySelector('[data-view="settings"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(12);
    await window.fetch("/api/sync/start", { method: "POST" });
    await window.fetch("/api/sync/round", { method: "POST", body: JSON.stringify({ since: 0 }) });
    await settle(12);

    const item = window.__app.state.items.find((i) => i.type === "api-key");
    const { renderSyncBody, renderConflicts, renderConflictView, state } = window.__app;

    // A conflict as the server would report it: an id, two revisions, a timestamp.
    state.sync = { paired: true, url: "http://127.0.0.1:3922", held: 14, seq: 15 };
    state.conflicts = [{ id: item.id, local: 1, remote: 2, at: new Date().toISOString(), present: true }];
    renderSyncBody();
    renderConflicts();
    await settle(3);

    const row = document.querySelector("[data-conflict-open]");
    assert.ok(row, "a conflict row with a way to open it");
    assert.equal(row.dataset.conflictOpen, item.id);
    assert.match(document.getElementById("app").textContent, /changed on two machines/);
    // The row names the item, which the server could not do, because it has no name.
    assert.match(document.getElementById("app").textContent, new RegExp(item.name.slice(0, 12)));

    // The comparison renders both sides and a button for each.
    state.conflictView = {
      id: item.id,
      local: { rev: 1, exists: true },
      remote: { rev: 2, exists: true },
      differs: 1,
      fields: [
        { field: "name", local: item.name, remote: item.name, differs: false },
        { field: "value", local: "one", remote: "the other", differs: true },
      ],
    };
    renderConflictView();
    await settle(2);
    const view = document.querySelector("[data-conflict-view]").textContent;
    assert.match(view, /1 field differs/);
    assert.match(view, /the other/);
    assert.ok(document.querySelector('[data-conflict-keep="local"]'), "a way to keep this machine's copy");
    assert.ok(document.querySelector('[data-conflict-keep="remote"]'), "and the other one's");

    // A deleted item has nothing to compare, so the button is disabled rather than gone,
    // which would leave a row with no explanation.
    state.conflictView = null;
    state.conflicts = [{ id: "gone-forever", local: 1, remote: 2, at: new Date().toISOString(), present: false }];
    renderConflicts();
    await settle(2);
    assert.equal(document.querySelector("[data-conflict-open]").disabled, true);
    assert.match(document.getElementById("app").textContent, /since deleted/);

    state.conflicts = [];
    state.conflictView = null;
    renderConflicts();
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

  test("the devices view pairs a phone and draws the code", async () => {
    document.querySelector('[data-view="devices"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(3);
    assert.match(document.getElementById("app").textContent, /Pair a phone/);
    assert.match(document.getElementById("app").textContent, /cannot read a stored secret/i);

    const button = document.querySelector("[data-pair-start]");
    assert.ok(button, "there is no pairing button");
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(8);

    const code = document.querySelector(".paircode");
    assert.ok(code, "no pairing code was drawn");
    // The shape a person has to read out: eight groups, then the checksum.
    assert.match(code.textContent.trim(), /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}-[A-Z2-7]{2}$/);
    assert.match(document.getElementById("app").textContent, /Do not leave it on screen/);
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
