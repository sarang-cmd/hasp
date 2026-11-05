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

  test("the activity log records what happened, and never a value", async () => {
    // The view used to claim "every copy, fill and rotation is recorded" while showing
    // one timestamp per item and labelling every row "copied". This is the log that
    // claim needed.
    const created = await call("/api/items", {
      method: "POST",
      body: { name: "Log subject", type: "api-key", service: "Logger", value: "EXAMPLE-log-secret-value" },
    });
    assert.equal(created.status, 201);
    const id = created.json.id;
    await call(`/api/items/${id}`, { method: "PUT", body: { value: "EXAMPLE-log-rotated" } });
    await call(`/api/items/${id}/touch`, { method: "POST", body: {} });

    const log = await call("/api/activity");
    assert.equal(log.status, 200);
    const actions = log.json.entries.filter((e) => e.id === id).map((e) => e.action).reverse();
    assert.deepEqual(actions, ["created", "edited", "copied"], "each write has its own entry");
    for (const entry of log.json.entries) {
      assert.equal(typeof entry.at, "string");
      assert.ok(entry.name.length > 0, "an entry names its item");
    }
    // Newest first, so the list reads the way the view shows it.
    const times = log.json.entries.map((e) => e.at);
    assert.deepEqual(times, [...times].sort().reverse());

    // The promise the view makes. Checked against the reply and against the file.
    const text = JSON.stringify(log.json);
    assert.equal(text.includes("EXAMPLE-log-secret-value"), false);
    assert.equal(text.includes("EXAMPLE-log-rotated"), false);
  });

  test("a deleted item can be listed and brought back", async () => {
    // The delete confirmation said an item "can be restored from the vault data" while
    // no route existed to list or restore one. This is that route, both ways.
    const created = await call("/api/items", {
      method: "POST",
      body: { name: "Bring back me", type: "api-key", service: "Return", value: "EXAMPLE-return" },
    });
    const id = created.json.id;
    await call(`/api/items/${id}`, { method: "DELETE" });

    const deleted = await call("/api/items/deleted");
    assert.equal(deleted.status, 200);
    const found = deleted.json.items.find((i) => i.id === id);
    assert.ok(found, "the deleted item is listed");
    assert.equal(found.name, "Bring back me", "and it is readable, not a stub row");
    assert.equal(found.value, "EXAMPLE-return", "with its value intact, because it was never dropped");
    assert.ok(found.deletedAt);

    const restored = await call(`/api/items/${id}?restore=1`, { method: "POST", body: {} });
    assert.equal(restored.status, 200);
    const after = await call("/api/items/deleted");
    assert.equal(after.json.items.some((i) => i.id === id), false, "it left the deleted list");
    const state = await call("/api/state");
    assert.ok(state.json.items.some((i) => i.id === id), "and it is in the vault again");

    // The restore is in the log, which is what the ACTIONS set always promised.
    const log = await call("/api/activity");
    assert.ok(log.json.entries.some((e) => e.id === id && e.action === "restored"));
  });

  test("a delete and a restore are logged as themselves", async () => {
    const created = await call("/api/items", {
      method: "POST",
      body: { name: "Delete subject", type: "api-key", value: "EXAMPLE-delete-me" },
    });
    const id = created.json.id;
    await call(`/api/items/${id}`, { method: "DELETE" });
    const log = await call("/api/activity");
    const mine = log.json.entries.filter((e) => e.id === id).map((e) => e.action);
    assert.ok(mine.includes("deleted"), `saw ${mine.join(", ")}`);
    assert.ok(mine.includes("created"));
  });

  test("the log is capped and says so", async () => {
    const log = await call("/api/activity?limit=2");
    assert.ok(log.json.entries.length <= 2);
    assert.ok(Number.isInteger(log.json.capped) && log.json.capped > 0);
    assert.ok(log.json.total >= log.json.entries.length);
  });

  test("a query searches the blind index and reports that it did", async () => {
    const res = await call("/api/state?q=stripe");
    assert.equal(res.status, 200);
    assert.equal(res.json.query, "stripe");
    assert.equal(res.json.indexed, true);
    assert.ok(res.json.items.length > 0);
    assert.ok(res.json.items.length < 15, "a query narrows the set");
    // Every row has to be there for a reason, so the reason is checked and not
    // just the count.
    for (const item of res.json.items) {
      const hay = `${item.name} ${item.service} ${item.host} ${(item.tags || []).join(" ")} ${item.notes || ""}`;
      assert.ok(/stripe/i.test(hay), `stripe matched ${item.name} with no visible reason`);
    }
  });

  test("an empty query returns everything and does not claim to have searched", async () => {
    const all = await call("/api/state");
    const empty = await call("/api/state?q=");
    assert.equal(empty.status, 200);
    assert.equal(empty.json.items.length, all.json.items.length);
    assert.equal(empty.json.indexed, undefined);
  });

  test("a query does not reach the plaintext of a value", async () => {
    // The blind index covers names, services, hosts, issuers, accounts, tags and
    // notes. It does not cover the secret itself. A word that appears only in a
    // stored value must not match, because indexing a secret would let anyone who
    // can query the index enumerate the secrets one guess at a time.
    const all = (await call("/api/state")).json.items;
    const target = all.find((i) => i.type === "api-key");
    assert.ok(target && target.value, "the sample set has an api key with a value");
    const word = String(target.value).replace(/[^\p{L}\p{N}]+/gu, "").slice(4, 12);
    assert.ok(word.length >= 4);
    const res = await call(`/api/state?q=${encodeURIComponent(word)}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 0, `${word} matched, so values are being indexed`);
  });

  test("sync starts, holds a token back, and refuses to run without a session", async () => {
    const before = await call("/api/sync/status");
    assert.equal(before.status, 200);
    assert.equal(before.json.paired, false);

    const started = await call("/api/sync/start", { method: "POST" });
    assert.equal(started.status, 200);
    assert.equal(typeof started.json.token, "string");
    assert.ok(started.json.token.length >= 40, "the write token is long enough to matter");
    assert.equal(started.json.vaultId.length > 0, true);

    // The status route describes the pairing and never repeats the token, because a
    // GET is the kind of thing that ends up in a log or a history entry.
    const status = await call("/api/sync/status");
    assert.equal(status.json.paired, true);
    assert.equal(status.json.token, undefined);
    assert.equal(JSON.stringify(status.json).includes(started.json.token), false);

    // Starting again reuses the pairing rather than minting a token nobody wrote down.
    const again = await call("/api/sync/start", { method: "POST" });
    assert.equal(again.json.reused, true);
    assert.equal(again.json.token, started.json.token);
  });

  test("a sync round pushes the vault as ciphertext and holds nothing readable", async () => {
    const round = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.equal(round.status, 200);
    assert.ok(round.json.pushed >= 14, `expected the seeded set to go out, pushed ${round.json.pushed}`);
    assert.deepEqual(round.json.conflicts, []);
    assert.equal(round.json.pulled.rejected, 0);

    // A second round with nothing changed must be quiet. Before the equal revision
    // rule, every round reported the whole vault back to itself as conflicts.
    const quiet = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.equal(quiet.json.pushed, 0);
    assert.deepEqual(quiet.json.conflicts, []);
  });

  test("sync routes refuse a request with no session", async () => {
    const started = await call("/api/sync/status", { useCookie: false });
    assert.equal(started.status, 401);
    const round = await call("/api/sync/round", { method: "POST", body: {}, useCookie: false });
    assert.equal(round.status, 401);
  });

  test("a healthy round reports no conflicts and logs none", async () => {
    // The pull marks what it received as already sent. Before that, every record the
    // round had just taken in was offered straight back and refused at an equal
    // revision, so a clean round reported the whole vault as conflicts with itself.
    const started = await call("/api/sync/start", { method: "POST" });
    assert.ok(started.json.vaultId);
    const first = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.equal(first.status, 200);
    const second = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.deepEqual(second.json.conflicts, [], "a repeat round is not a conflict");
    const log = await call("/api/sync/conflicts");
    assert.equal(log.status, 200);
    assert.deepEqual(log.json.conflicts, []);
  });

  test("both sides of a conflict are shown field by field", async () => {
    const items = (await call("/api/state")).json.items;
    const target = items.find((i) => i.type === "api-key");
    const compared = await call(`/api/sync/conflicts/compare?id=${target.id}`);
    assert.equal(compared.status, 200);
    assert.equal(compared.json.id, target.id);
    assert.ok(compared.json.local.exists && compared.json.remote.exists);
    // Nothing has clashed yet, so no field differs and the two revisions agree.
    assert.equal(compared.json.differs, 0);
    assert.equal(compared.json.local.rev, compared.json.remote.rev);
    const value = compared.json.fields.find((f) => f.field === "value");
    assert.ok(value, "the secret is one of the compared fields");
    assert.equal(value.local, value.remote);
  });

  test("compare names a missing record rather than inventing one", async () => {
    const res = await call("/api/sync/conflicts/compare?id=not-a-real-id");
    assert.equal(res.status, 404);
    assert.match(res.json.error, /no record/);
  });

  test("resolving refuses a side that is not one of the two", async () => {
    const items = (await call("/api/state")).json.items;
    const target = items.find((i) => i.type === "api-key");
    const res = await call("/api/sync/conflicts/resolve", {
      method: "POST",
      body: { id: target.id, keep: "whatever is newer" },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /local or remote/);
  });

  test("keeping the remote copy takes it and beats the revision that lost", async () => {
    const items = (await call("/api/state")).json.items;
    const target = items.find((i) => i.type === "api-key");
    const before = (await call(`/api/sync/conflicts/compare?id=${target.id}`)).json;
    const res = await call("/api/sync/conflicts/resolve", {
      method: "POST",
      body: { id: target.id, keep: "remote" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.kept, "remote");
    // The record now sits above both sides, so a later write cannot collide with it.
    assert.ok(res.json.rev > before.remote.rev, `${res.json.rev} is not above ${before.remote.rev}`);
    const after = (await call(`/api/sync/conflicts/compare?id=${target.id}`)).json;
    assert.equal(after.differs, 0, "the two sides agree afterwards");
    // And a round straight after is quiet, which means the store took the new revision.
    const round = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.deepEqual(round.json.conflicts, []);
  });

  test("keeping the local copy raises it above the store's", async () => {
    const items = (await call("/api/state")).json.items;
    const target = items.find((i) => i.type === "api-key");
    const before = (await call(`/api/sync/conflicts/compare?id=${target.id}`)).json;
    const res = await call("/api/sync/conflicts/resolve", {
      method: "POST",
      body: { id: target.id, keep: "local" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.kept, "local");
    assert.ok(res.json.rev > before.remote.rev);
    const round = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.deepEqual(round.json.conflicts, []);
  });

  test("resolve refuses a request with no session", async () => {
    const res = await call("/api/sync/conflicts/resolve", {
      method: "POST",
      body: { id: "x", keep: "local" },
      useCookie: false,
    });
    assert.equal(res.status, 401);
  });

  test("the conflict log describes an entry by id and never by name", async () => {
    const log = await call("/api/sync/conflicts");
    const text = JSON.stringify(log.json);
    // No item name appears, because the store never had one to give.
    const items = (await call("/api/state")).json.items;
    for (const item of items.slice(0, 5)) {
      assert.equal(text.includes(item.name), false, `${item.name} leaked into the log`);
    }
    assert.ok(Array.isArray(log.json.conflicts));
  });

  test("forgetting the pairing stops the round and leaves the stored copy alone", async () => {
    const before = await call("/api/sync/status");
    assert.equal(before.json.paired, true);
    const dropped = await call("/api/sync/pairing", { method: "DELETE" });
    assert.equal(dropped.json.removed, 1);
    const after = await call("/api/sync/status");
    assert.equal(after.json.paired, false);
    const round = await call("/api/sync/round", { method: "POST", body: { since: 0 } });
    assert.equal(round.status, 409);
  });

  test("every word of a query has to match", async () => {
    const both = await call("/api/state?q=stripe%20webhooks");
    const one = await call("/api/state?q=stripe");
    assert.ok(both.json.items.length <= one.json.items.length);
    assert.ok(both.json.items.length > 0, "one row carries both words in its note");
  });

  test("a query that matches nothing comes back empty rather than as an error", async () => {
    const res = await call("/api/state?q=zenith");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.items, []);
    assert.equal(res.json.indexed, true);
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

// ---------------------------------------------------------------------------
// What the server leaves on disk.
//
// The suite above runs ephemeral, so nothing has covered a real vault directory
// until now. This starts a second server pointed at a temporary directory and
// pokes the files while it writes.

describe("on disk", () => {
  let dir, own, ownBase, ownCookie;

  /** Ask the second server something, with its own cookie. */
  async function ask(path, { method = "GET", body } = {}) {
    const headers = { "content-type": "application/json" };
    if (ownCookie) headers.cookie = ownCookie;
    const res = await fetch(`${ownBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0];
      ownCookie = pair.endsWith("=") ? "" : pair;
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  before(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = await mkdtemp(join(tmpdir(), "hasp-disk-"));
    own = spawn(process.execPath, ["server.mjs", "--port=3923"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, HASP_VAULT_DIR: dir, PORT: "3923", HASP_EPHEMERAL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    ownBase = "http://127.0.0.1:3923";
    const lines = [];
    own.stdout.setEncoding("utf8");
    own.stdout.on("data", (c) => lines.push(c));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (lines.join("").includes("Hasp on")) break;
      if (own.exitCode !== null) throw new Error(`disk server exited: ${lines.join("")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const unlocked = await ask("/api/unlock", { method: "POST", body: { password: "foundry-nightshift-2026" } });
    assert.equal(unlocked.status, 200);
  });

  after(async () => {
    if (own && own.exitCode === null) {
      own.kill("SIGTERM");
      await once(own, "exit").catch(() => {});
    }
    const { rm } = await import("node:fs/promises");
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("the vault file is never readable in a half-written state", async () => {
    // writeFile truncates in place, so a reader polling during a write sees a
    // short file. Before this was fixed the same loop found 37 unreadable reads
    // out of 200. The bar is zero, and the payloads are large enough to make the
    // window wide.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const payload = "Q".repeat(60000);
    const writing = (async () => {
      for (let i = 0; i < 60; i += 1) {
        await ask("/api/items", {
          method: "POST",
          body: { name: `Torn ${i}`, type: "note", value: payload + i },
        });
      }
    })();

    let reads = 0;
    let bad = 0;
    const until = setTimeout(() => {}, 0);
    clearTimeout(until);
    while (true) {
      const done = await Promise.race([writing.then(() => true), new Promise((r) => setTimeout(() => r(false), 0))]);
      try {
        JSON.parse(await readFile(join(dir, "vault.json"), "utf8"));
        reads += 1;
      } catch (err) {
        if (err.code === "ENOENT") {
          // Not written yet, which is not a torn read.
        } else {
          bad += 1;
          reads += 1;
        }
      }
      if (done) break;
    }
    await writing;
    assert.ok(reads > 0, "the poll never managed to read the file");
    assert.equal(bad, 0, `${bad} of ${reads} reads saw a partial vault`);
  });

  test("a write leaves no temporary files behind", async () => {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    assert.deepEqual(names.filter((n) => n.includes(".tmp")), [], `left behind: ${names.join(", ")}`);
  });

  test("the files are still only readable by their owner", async () => {
    const { stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const name of ["vault.json", "activity.json"]) {
      const mode = (await stat(join(dir, name))).mode & 0o777;
      assert.equal(mode, 0o600, `${name} is ${mode.toString(8)}`);
    }
  });
});
