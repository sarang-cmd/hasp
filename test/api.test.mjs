// Server tests. These start the real server on a random port and talk to it over
// HTTP, so they cover routing, cookies, origin checks and persistence rather
// than a stubbed handler.
//
// Every secret used here is invented and generated in the test.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

let server;
let base;
let cookie = "";

/** A Groq shaped value, generated so no credential literal sits in the source. */
const GROQ = "gsk_prod_" + Array.from({ length: 32 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[i % 36]).join("");

/** A small cookie jar: one field, because the app sets one cookie. */
async function call(path, { method = "GET", body, origin, useCookie = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (useCookie && cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) {
    const pair = set.split(";")[0];
    cookie = pair.endsWith("=") ? "" : pair;
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html or plain text
  }
  return { status: res.status, headers: res.headers, json, text };
}

before(async () => {
  // A free port, ephemeral storage, so the test never touches .vault/.
  server = spawn(process.execPath, ["server.mjs", "--port=3921"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HASP_EPHEMERAL: "1", PORT: "3921" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = "http://127.0.0.1:3921";

  // Wait for the listen line rather than sleeping.
  const lines = [];
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => lines.push(chunk));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (lines.join("").includes("Hasp on")) return;
    if (server.exitCode !== null) throw new Error(`server exited: ${lines.join("")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${lines.join("")}`);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
});

describe("static files", () => {
  test("the shell, stylesheets and scripts are served", async () => {
    for (const [path, type] of [
      ["/", "text/html"],
      ["/tokens.css", "text/css"],
      ["/app.css", "text/css"],
      ["/app.js", "text/javascript"],
      ["/appearance.js", "text/javascript"],
      ["/icons.js", "text/javascript"],
      ["/main.js", "text/javascript"],
    ]) {
      const res = await call(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type"), new RegExp(type), path);
    }
  });

  test("fonts and brand marks are served from the app origin", async () => {
    for (const path of ["/fonts/archivo-latin-400-normal.woff2", "/brands/groq.svg", "/brands/github.svg", "/favicon.svg"]) {
      const res = await call(path);
      assert.equal(res.status, 200, path);
    }
  });

  test("a traversal attempt is refused", async () => {
    const res = await call("/../server.mjs");
    assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
  });

  test("security headers are present", async () => {
    const res = await call("/");
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });
});

describe("session", () => {
  test("the vault starts locked", async () => {
    const res = await call("/api/session");
    assert.equal(res.status, 200);
    assert.equal(res.json.unlocked, false);
  });

  test("the vault API refuses a request with no session", async () => {
    const res = await call("/api/state");
    assert.equal(res.status, 401);
  });

  test("a wrong password is refused without saying why", async () => {
    const res = await call("/api/unlock", { method: "POST", body: { password: "definitely not it" } });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, "Wrong master password");
  });

  test("the right password opens a session and sets a hardened cookie", async () => {
    const res = await call("/api/unlock", { method: "POST", body: { password: "foundry-nightshift-2026" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.unlocked, true);
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.ok(cookie.startsWith("hasp_session="));
  });

  test("the state route returns the sample vault once unlocked", async () => {
    const res = await call("/api/state");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.items));
    assert.ok(res.json.items.length >= 14, `expected the seeded set, got ${res.json.items.length}`);
    const groq = res.json.items.find((i) => i.name === "Groq production");
    assert.ok(groq, "the sample set includes Groq production");
    assert.equal(groq.env, "prod");
    assert.ok(groq.why.includes("console.groq.com"), "every item carries its suggestion reason");
  });

  test("a one-time code item arrives with a live code", async () => {
    const res = await call("/api/state");
    const totpItem = res.json.items.find((i) => i.type === "totp");
    assert.ok(totpItem);
    assert.match(totpItem.totp.code.replace(/\s/g, ""), /^\d{6}$/);
    assert.ok(totpItem.totp.remaining >= 1 && totpItem.totp.remaining <= 30);
  });
});

describe("origin checks", () => {
  test("a cross-origin write is refused", async () => {
    const res = await call("/api/items", {
      method: "POST",
      body: { name: "Injected" },
      origin: "https://evil.example",
    });
    assert.equal(res.status, 403);
  });

  test("a same-origin write is allowed", async () => {
    const res = await call("/api/items", {
      method: "POST",
      body: { name: "Origin check item", type: "note", notes: "invented" },
      origin: base,
    });
    assert.equal(res.status, 201);
    assert.ok(res.json.id);
  });
});

describe("items", () => {
  let id;

  test("create, read back through state, update, delete", async () => {
    const created = await call("/api/items", {
      method: "POST",
      body: {
        name: "Test key",
        service: "Groq",
        host: "console.groq.com",
        type: "api-key",
        env: "staging",
        value: GROQ,
      },
    });
    assert.equal(created.status, 201);
    id = created.json.id;

    let state = await call("/api/state");
    let item = state.json.items.find((i) => i.id === id);
    assert.ok(item, "the new item appears in state");
    assert.equal(item.value, GROQ);
    assert.equal(item.version, 1);

    const updated = await call(`/api/items/${id}`, { method: "PUT", body: { ...item, value: "EXAMPLE-groq-staging-rotated" } });
    assert.equal(updated.status, 200);
    state = await call("/api/state");
    item = state.json.items.find((i) => i.id === id);
    assert.equal(item.value, "EXAMPLE-groq-staging-rotated");
    assert.equal(item.version, 2);

    const deleted = await call(`/api/items/${id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    state = await call("/api/state");
    assert.equal(state.json.items.some((i) => i.id === id), false);
  });

  test("a bad item type is refused with a 500, not a crash", async () => {
    const res = await call("/api/items", { method: "POST", body: { name: "x", type: "not-a-type" } });
    assert.ok(res.status >= 400);
    // The server must still be alive after rejecting it.
    const alive = await call("/api/session");
    assert.equal(alive.status, 200);
  });

  test("an unknown item cannot be updated", async () => {
    const res = await call("/api/items/does-not-exist", { method: "PUT", body: { name: "x" } });
    assert.ok(res.status >= 400);
  });

  test("touch records a use", async () => {
    const state = await call("/api/state");
    const target = state.json.items.find((i) => i.type === "api-key");
    const res = await call(`/api/items/${target.id}/touch`, { method: "POST" });
    assert.equal(res.status, 200);
  });
});

describe("import", () => {
  test("keep json parses, and accepting stores encrypted items", async () => {
    const notes = JSON.stringify([
      { title: "Acme production", textContent: `acme prod key ${GROQ}` },
      { title: "Not a secret", textContent: "buy oat milk and rice" },
    ]);
    const parsed = await call("/api/import/parse", { method: "POST", body: { text: notes, filename: "keep.json" } });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.json.source, "Google Keep, JSON");
    assert.equal(parsed.json.candidates.length, 2);

    const before = (await call("/api/state")).json.items.length;
    const accepted = await call("/api/import/accept", { method: "POST", body: { acceptAll: true } });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.json.added >= 1);

    const after = (await call("/api/state")).json.items;
    assert.equal(after.length, before + accepted.json.added);
    assert.ok(after.some((i) => i.name === "Acme production"));
  });

  test("a duplicate is flagged and not stored twice", async () => {
    const notes = JSON.stringify([{ title: "Acme again", textContent: GROQ }]);
    const parsed = await call("/api/import/parse", { method: "POST", body: { text: notes, filename: "keep.json" } });
    assert.equal(parsed.json.duplicates.length, 1, "the value is already in the vault");
  });

  test("a malformed file is rejected with a readable message", async () => {
    const res = await call("/api/import/parse", { method: "POST", body: { text: "{broken", filename: "keep.json" } });
    assert.equal(res.status, 400);
    assert.ok(res.json.error.length > 10);
  });

  test("an otpauth paste becomes a one-time code candidate", async () => {
    const res = await call("/api/import/parse", {
      method: "POST",
      body: { text: "otpauth://totp/Acme:dev@acme.test?secret=GEZDGNBVGY3TQOJQ&issuer=Acme", filename: "codes.txt" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.candidates[0].type, "totp");
    assert.equal(res.json.candidates[0].totp.secret, "GEZDGNBVGY3TQOJQ");
  });

  test("a 2FAS export becomes one-time code candidates with brands", async () => {
    const json = JSON.stringify({
      services: [
        { name: "GitHub", secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otp: { issuer: "GitHub", account: "you@example.com" } },
        { name: "Cloudflare", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", otp: { issuer: "Cloudflare" } },
      ],
    });
    const res = await call("/api/import/parse", { method: "POST", body: { text: json, filename: "2fas.json" } });
    assert.equal(res.status, 200);
    assert.match(res.json.source, /2FAS/);
    assert.equal(res.json.candidates.length, 2);
    const gh = res.json.candidates.find((c) => c.brand === "github");
    assert.ok(gh, "the GitHub code lost its brand");
    assert.equal(gh.totp.secret, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    assert.ok(gh.id, "the candidate has no id, so review cannot track it");
  });

  test("a truncated authenticator export falls back instead of claiming it", async () => {
    const res = await call("/api/import/parse", {
      method: "POST",
      body: { text: '{"services": [{"name": "GitHub"', filename: "2fas.json" },
    });
    assert.notEqual(res.json.source, "2FAS");
  });

  test("an accepted authenticator import stores a code that produces a live token", async () => {
    const json = JSON.stringify({
      services: [{ name: "Acme", secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otp: { issuer: "Acme" } }],
    });
    const parsed = await call("/api/import/parse", { method: "POST", body: { text: json, filename: "2fas.json" } });
    assert.equal(parsed.json.candidates.length, 1);
    const accepted = await call("/api/import/accept", { method: "POST", body: { acceptAll: true } });
    assert.equal(accepted.json.added, 1);
    const items = (await call("/api/state")).json.items;
    const acme = items.find((i) => i.name === "Acme" && i.type === "totp");
    assert.ok(acme, "the imported code is not in the vault");
    assert.match(acme.totp.code, /\d/, "the stored code does not produce a token");
  });

  test("a csv is recognised from its contents when the name gives nothing away", async () => {
    const csv = "name,url,username,password\nAcme,https://acme.test,dev,sup3r-invented-value";
    const res = await call("/api/import/parse", { method: "POST", body: { text: csv, filename: "export.txt" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.source, "Password manager CSV");
  });

  test("a pending parse survives until it is decided", async () => {
    // The previous test left a valid one-time code waiting. Accepting it now is
    // the expected behaviour: a parse is not thrown away because a second file
    // was looked at. What must not happen is the same parse being stored twice.
    const first = await call("/api/import/accept", { method: "POST", body: { acceptAll: true } });
    assert.equal(first.status, 200);
    // Parsing a second file replaces the first, so only the most recent parse is
    // waiting. One candidate from the csv, accepted once.
    assert.equal(first.json.added, 1);

    const again = await call("/api/import/accept", { method: "POST", body: { acceptAll: true } });
    assert.equal(again.status, 400, "a second accept must not store anything");
    assert.match(again.json.error, /No import is waiting/);
  });

  test("an empty parse is refused", async () => {
    const res = await call("/api/import/accept", { method: "POST", body: { acceptAll: true } });
    assert.equal(res.status, 400);
  });
});

describe("content security policy", () => {
  test("the inline boot script is allowed by its own hash", async () => {
    // The theme has to be set before first paint, so it cannot be a module. With a
    // plain script-src 'self' the browser blocks it silently and the flash it
    // prevents happens on every load. The hash is what makes that script, and only
    // that script, legal.
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(inline, "index.html no longer has an inline boot script");
    const hash = "sha256-" + createHash("sha256").update(inline[1], "utf8").digest("base64");

    const res = await call("/");
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src [^;]*'self'/, "script-src must still allow the app's modules");
    assert.ok(csp.includes(hash), `CSP does not carry the boot script hash.\n  file: ${hash}\n  csp:  ${csp}`);
    assert.ok(!csp.includes("'unsafe-inline'") || !/script-src[^;]*unsafe-inline/.test(csp), "script-src must not allow arbitrary inline script");
  });
});

describe("export", () => {
  test("exports plaintext with a warning and a download name", async () => {
    const res = await call("/api/export");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="hasp-export-/);
    assert.match(res.json.warning, /Plaintext/);
    assert.ok(res.json.items.length > 0);
    assert.ok(res.json.items[0].value !== undefined, "an export is the point at which plaintext leaves");
  });
});

describe("lock", () => {
  test("locking drops the session and the next request is refused", async () => {
    const res = await call("/api/lock", { method: "POST" });
    assert.equal(res.status, 200);
    const state = await call("/api/state");
    assert.equal(state.status, 401);
    // Reopen for any later test in this file.
    const again = await call("/api/unlock", { method: "POST", body: { password: "foundry-nightshift-2026" } });
    assert.equal(again.status, 200);
  });
});
