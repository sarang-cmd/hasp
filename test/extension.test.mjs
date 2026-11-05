// Tests for the browser extension.
//
// The extension cannot be run in this sandbox, and a test that checks a manifest is
// valid JSON proves nothing about the parts that matter. So these tests cover the
// pure logic: what address is allowed, what a lock looks like, and whether the
// manifest grants more than the code uses.
//
// Every module under test is imported with a small `chrome` and `fetch` stub rather
// than a browser, because the logic is deliberately thin enough to run that way.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");

const read = (p) => readFileSync(join(EXT, p), "utf8");
const manifest = () => JSON.parse(read("manifest.json"));

describe("manifest", () => {
  test("is manifest version three", () => {
    assert.equal(manifest().manifest_version, 3);
  });

  test("asks for no host permission beyond loopback", () => {
    const hosts = manifest().host_permissions || [];
    for (const pattern of hosts) {
      assert.match(
        pattern,
        /^https?:\/\/(127\.0\.0\.1|localhost)(\/\*)?$/,
        `${pattern} is a host permission that is not loopback`,
      );
    }
  });

  test("requests no permission the code does not use", () => {
    // Each granted permission needs a reason in this list. A permission granted
    // "in case" is a permission an attacker can use.
    const allowed = new Set(["storage", "activeTab", "scripting"]);
    for (const p of manifest().permissions || []) {
      assert.ok(allowed.has(p), `unexpected permission: ${p}`);
    }
  });

  test("declares no content script", () => {
    // Reading page content would mean page data passing through extension code.
    // Nothing reads it, so nothing should be granted the ability to.
    assert.equal(manifest().content_scripts, undefined);
  });

  test("every file the manifest names exists", () => {
    const m = manifest();
    const named = [
      m.action.default_popup,
      m.options_ui.page,
      m.background.service_worker,
      ...Object.values(m.action.default_icon),
      ...Object.values(m.icons),
    ];
    for (const file of named) assert.ok(existsSync(join(EXT, file)), `missing: ${file}`);
  });

  test("the extension pages forbid remote script and remote frames", () => {
    const csp = manifest().content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes("script-src 'self' http"), "remote script is allowed");
    assert.ok(!csp.includes("'unsafe-eval'"), "eval is allowed");
    assert.match(csp, /object-src 'none'/);
  });
});

// --- the client, with stubs -------------------------------------------------

let client;

before(async () => {
  globalThis.chrome = {
    storage: {
      local: {
        _data: {},
        async get(key) {
          return key in this._data ? { [key]: this._data[key] } : {};
        },
        async set(obj) {
          Object.assign(this._data, obj);
        },
      },
    },
  };
  client = await import("../extension/lib/client.js");
});

describe("search", () => {
  test("a query goes to the vault instead of narrowing the list here", async () => {
    // The popup used to filter its own list by name, service, host and env. A match in
    // a note was invisible, because notes never reach the popup. This pins the call
    // that replaced it.
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ items: [] }),
        text: async () => "{}",
      };
    };
    try {
      await client.state("stripe webhooks");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0], /\/api\/state\?q=stripe%20webhooks$/, "the query is escaped and sent");
  });

  test("no query asks for the whole list and does not send an empty q", async () => {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ items: [] }),
        text: async () => "{}",
      };
    };
    try {
      await client.state();
      await client.state("");
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const url of seen) {
      assert.equal(url.includes("?q="), false, `${url} carried an empty query`);
    }
  });
});

describe("vault address", () => {
  test("accepts http loopback", () => {
    assert.equal(client.normaliseOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
    assert.equal(client.normaliseOrigin("http://localhost:8080"), "http://localhost:8080");
    assert.equal(client.normaliseOrigin("  http://127.0.0.1:3100/  "), "http://127.0.0.1:3100");
  });

  test("drops a path rather than keeping it", () => {
    assert.equal(client.normaliseOrigin("http://127.0.0.1:3000/app?x=1"), "http://127.0.0.1:3000");
  });

  test("refuses a remote host", () => {
    // The whole point of the proxy is that no session cookie leaves this machine.
    for (const value of [
      "https://example.com",
      "http://example.com",
      "http://192.168.1.10:3000",
      "http://10.0.0.5",
      "http://127.0.0.1.evil.com",
    ]) {
      assert.equal(client.normaliseOrigin(value), null, `${value} was accepted`);
    }
  });

  test("refuses https, because the vault does not serve TLS", () => {
    assert.equal(client.normaliseOrigin("https://127.0.0.1:3000"), null);
  });

  test("refuses a credentialed address", () => {
    assert.equal(client.normaliseOrigin("http://user:pass@127.0.0.1:3000"), null);
  });

  test("refuses junk", () => {
    for (const value of ["", "not a url", "javascript:alert(1)", "file:///etc/passwd", null]) {
      assert.equal(client.normaliseOrigin(value), null, `${value} was accepted`);
    }
  });

  test("saving a bad address throws rather than storing it", async () => {
    await assert.rejects(() => client.setOrigin("https://example.com"), /127\.0\.0\.1/);
  });

  test("a saved address round trips, and a bad stored value falls back", async () => {
    await client.setOrigin("http://127.0.0.1:3456");
    assert.equal(await client.getOrigin(), "http://127.0.0.1:3456");
    // Simulate a value that got into storage some other way.
    await chrome.storage.local.set({ "hasp.origin": "https://evil.example" });
    assert.equal(await client.getOrigin(), client.DEFAULT_ORIGIN);
  });
});

describe("requests", () => {
  test("a locked vault becomes a typed error, not an empty list", async () => {
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(
      () => client.request("/api/state"),
      (err) => err.code === "locked" && /locked/i.test(err.message),
    );
  });

  test("an error body is passed through as the message", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Cross-origin request refused" }), { status: 403 });
    await assert.rejects(() => client.request("/api/items", { method: "POST", body: {} }), /Cross-origin/);
  });

  test("a non-JSON answer from something that is not the vault does not throw a parse error", async () => {
    globalThis.fetch = async () => new Response("<html>proxy</html>", { status: 200 });
    const out = await client.request("/api/session");
    assert.equal(out, null);
  });

  test("the session cookie is sent, and no secret is added by the extension", async () => {
    let seen;
    globalThis.fetch = async (_url, opts) => {
      seen = opts;
      return new Response(JSON.stringify({ unlocked: true }), { status: 200 });
    };
    await client.request("/api/session");
    assert.equal(seen.credentials, "include");
    assert.equal(seen.headers["authorization"], undefined);
  });
});

describe("matching a page to items", () => {
  const items = [
    { id: "1", name: "Stripe prod", host: "stripe.com", service: "Stripe" },
    { id: "2", name: "Stripe dashboard", host: "dashboard.stripe.com", service: "Stripe" },
    { id: "3", name: "Groq", host: "groq.com", service: "Groq" },
    { id: "4", name: "Note", host: "", service: "" },
    { id: "5", name: "Unrelated", host: "example.org", service: "Unrelated" },
  ];

  test("an exact host comes first", () => {
    const out = client.matchHost(items, "dashboard.stripe.com");
    assert.equal(out[0].id, "2");
    assert.ok(out.some((i) => i.id === "1"), "the parent domain should still match");
  });

  test("a subdomain finds the apex item", () => {
    const out = client.matchHost(items, "api.groq.com");
    assert.deepEqual(out.map((i) => i.id), ["3"]);
  });

  test("www is ignored", () => {
    assert.equal(client.matchHost(items, "www.groq.com")[0].id, "3");
  });

  test("an unrelated host matches nothing", () => {
    assert.deepEqual(client.matchHost(items, "unrelated.example.net"), []);
  });

  test("an item with no host is never matched by accident", () => {
    const out = client.matchHost(items, "nothing.test");
    assert.deepEqual(out, []);
  });

  test("an empty hostname matches nothing rather than everything", () => {
    assert.deepEqual(client.matchHost(items, ""), []);
  });

  test("a service name matches only when the whole host is that name", () => {
    const named = [{ id: "9", name: "Internal", host: "", service: "Cloudflare" }];
    assert.equal(client.matchHost(named, "cloudflare").length, 1, "a bare host should match the service");
    assert.equal(
      client.matchHost(named, "cloudflare.example.net").length,
      0,
      "a subdomain of another site is not the service",
    );
  });

  test("tab urls that are not web pages have no host", () => {
    assert.equal(client.hostOf("chrome://newtab"), "");
    assert.equal(client.hostOf("about:blank"), "");
    assert.equal(client.hostOf("not a url"), "");
    assert.equal(client.hostOf("https://groq.com/console"), "groq.com");
  });
});

// --- fill -------------------------------------------------------------------
//
// The injected function is the only code here that runs inside a page, so a test
// that only reads its source would miss the interesting failures. jsdom is used to
// run it against a real DOM: a field that is hidden, a field that is a decoy, a
// field whose value setter was overridden by the page.

describe("fill", () => {
  let fill;

  before(async () => {
    fill = await import("../extension/lib/fill.js");
  });

  /**
   * A page in jsdom, with `armedFill` installed into it.
   *
   * The function is evaluated inside the window rather than called from here. That
   * is what the extension does: executeScript serialises the function and runs it in
   * the page's own context, which is why it may only use page globals. A test that
   * called it from node would need `document` from somewhere and would not be
   * testing the thing that ships.
   */
  async function page(html) {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    // jsdom does not lay anything out, so every box is 0x0 and the visibility check
    // would refuse everything. Give every element a box; a test that cares about
    // visibility overrides this on the element it names.
    dom.window.Element.prototype.getBoundingClientRect = function () {
      return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0, toJSON() {} };
    };
    dom.window.eval(`window.__armedFill = ${fill.armedFill.toString()};`);
    dom.run = (value, ttl = 20000) => dom.window.__armedFill(value, ttl);
    return dom;
  }

  test("fill is refused on a page that is not a web page", () => {
    for (const url of ["chrome://newtab", "about:blank", "file:///etc/passwd", "", "not a url"]) {
      assert.equal(fill.fillTarget(url).ok, false, `${url || "(empty)"} was offered fill`);
    }
  });

  test("fill is refused on the vault's own origin", () => {
    const target = fill.fillTarget("http://127.0.0.1:3000/app", "http://127.0.0.1:3000");
    assert.equal(target.ok, false);
    assert.equal(target.reason, "vault-page");
    // A port is part of an origin, so the same host on another port is a different
    // page and is allowed. Getting this wrong the other way would block the product
    // from ever filling a local development site.
    assert.equal(fill.fillTarget("http://127.0.0.1:8080/", "http://127.0.0.1:3000").ok, true);
  });

  test("a normal web page is offered fill", () => {
    assert.equal(fill.fillTarget("https://console.groq.com/login").ok, true);
    assert.equal(fill.fillTarget("http://localhost:5173/").ok, true);
  });

  test("every refusal has a sentence and the sentences are fixed", () => {
    assert.match(fill.fillReasonText("not-web-page"), /web page/);
    assert.match(fill.fillReasonText("vault-page"), /vault/);
    assert.equal(fill.fillReasonText("no-field"), "");
    // Nothing page-supplied can reach this function: it takes a reason, not text.
    assert.equal(fill.armedFill.length, 2);
  });

  test("a value goes into the field the user was already in", async () => {
    const dom = await page(`<input id="key" type="text">`);
    const input = dom.window.document.getElementById("key");
    input.focus();
    const out = dom.run("EXAMPLE-value");
    assert.equal(out.ok, true);
    assert.equal(out.how, "focused");
    assert.equal(input.value, "EXAMPLE-value");
  });

  test("the page is told, so a framework does not post an empty form", async () => {
    const dom = await page(`<input id="key" type="text">`);
    const input = dom.window.document.getElementById("key");
    input.focus();
    const seen = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));
    dom.run("EXAMPLE-value");
    assert.deepEqual(seen, ["input", "change"]);
  });

  test("a value setter the page overrode is bypassed", async () => {
    // This is the failure that looks like "fill did nothing": a site that defines its
    // own value setter swallows the assignment, the DOM looks right, and the request
    // goes out empty.
    const dom = await page(`<input id="key" type="text">`);
    const input = dom.window.document.getElementById("key");
    Object.defineProperty(input, "value", { set() {}, get() { return ""; }, configurable: true });
    input.focus();
    dom.run("EXAMPLE-value");
    // Read through the prototype, because the instance property this test defined is
    // the one being bypassed. Reading `input.value` would read the stub back and
    // agree with itself.
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value");
    assert.equal(descriptor.get.call(input), "EXAMPLE-value", "the native setter was not used");
  });

  test("a hidden field is not filled", async () => {
    const dom = await page(`<input id="key" type="text" style="display:none">`);
    const input = dom.window.document.getElementById("key");
    input.focus();
    const out = dom.run("EXAMPLE-value");
    assert.equal(out.ok, true, "it falls back to waiting rather than refusing outright");
    assert.equal(out.how, "armed");
    assert.equal(input.value, "", "a field the page keeps off screen is a clipboard");
  });

  test("a checkbox is not a field to fill", async () => {
    const dom = await page(`<input id="box" type="checkbox">`);
    const box = dom.window.document.getElementById("box");
    box.focus();
    const out = dom.run("EXAMPLE-value");
    assert.equal(out.how, "armed");
    assert.equal(box.checked, false);
  });

  test("when nothing is focused, the next click fills and then stops", async () => {
    const dom = await page(`<button id="b">Decoy</button><input id="key" type="text">`);
    const doc = dom.window.document;
    const input = doc.getElementById("key");
    const out = dom.run("EXAMPLE-value");
    assert.equal(out.how, "armed");
    doc.body.focus();
    input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
    assert.equal(input.value, "EXAMPLE-value");

    // Armed once, not forever: a second field on the same page must not receive it.
    const second = doc.createElement("input");
    doc.body.appendChild(second);
    second.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
    assert.equal(second.value, "", "the value was written twice");
  });

  test("it gives up on its own", async () => {
    const dom = await page(`<input id="key" type="text">`);
    const input = dom.window.document.getElementById("key");
    dom.run("EXAMPLE-value", 10);
    await new Promise((r) => setTimeout(r, 40));
    input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
    assert.equal(input.value, "", "it was still armed after its time ran out");
  });

  test("no value is left reachable after it is spent", async () => {
    const dom = await page(`<input id="key" type="text">`);
    const input = dom.window.document.getElementById("key");
    input.focus();
    dom.run("EXAMPLE-value");
    // The value is in the DOM because that is what was asked for, and in nowhere
    // else this test can see. The source is checked for the absence of storage.
    const source = read("lib/fill.js");
    assert.ok(!/storage|sessionStorage|localStorage|sendMessage|\bfetch\b/.test(source), "the injected code can reach storage or the network");
  });
});

describe("what the manifests and pages allow", () => {
  test("scripting is granted for fill and nothing broader", () => {
    const perms = manifest().permissions || [];
    assert.ok(perms.includes("scripting"), "fill cannot work without it");
    // A content_scripts block would run code on every page the user visits, which
    // this design deliberately does not do.
    assert.equal(manifest().content_scripts, undefined);
  });

  test("the popup refuses to fill the vault page", () => {
    const source = read("popup.js");
    assert.match(source, /fillTarget\(activeTab\?\.url, current\.origin/);
    // The guard is only real if the origin it compares against is ever set. It was
    // never assigned for a while, which made the vault-page check always pass.
    assert.match(source, /current\.origin = await getOrigin\(\)/);
  });
});
