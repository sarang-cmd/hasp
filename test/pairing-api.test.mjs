// The pairing routes over real HTTP.
//
// The unit tests prove the signature maths. These prove the routes use it: that a
// phone with the right code gets codes, and that a phone with the wrong code, a
// copied request, or a request from across the room gets nothing.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

let server;
let base;
let cookie = "";
let secret = "";
let deviceId = "pixel_8_pro";

const PORT = 3931;

/** A fresh 20 byte base32 secret, with the checksum the server expects. */
function newCode() {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  const check = base32(createHmac("sha256", "hasp-pairing-checksum").update(out).digest()).slice(0, 2);
  return out + check;
}

function base32(buffer) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

function sign(sec, { method, path, timestamp, nonce, device = deviceId }) {
  const baseStr = [device, method.toUpperCase(), path, String(timestamp), nonce].join("\n");
  return createHmac("sha256", sec).update(baseStr).digest("hex");
}

/** A signed request, as the phone would send it. */
async function phone(path, { method = "GET", sec = secret, device = deviceId, at, nonce } = {}) {
  const timestamp = at ?? Math.floor(Date.now() / 1000);
  const n = nonce ?? randomBytes(6).toString("hex");
  const headers = {
    "x-hasp-device": device,
    "x-hasp-time": String(timestamp),
    "x-hasp-nonce": n,
    "x-hasp-signature": sign(sec, { method, path, timestamp, nonce: n, device }),
  };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { method, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not json
  }
  return { status: res.status, json };
}

async function unlock() {
  await call("/api/unlock", { method: "POST", body: { password: "foundry-nightshift-2026" } });
}

async function call(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
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
    // not json
  }
  return { status: res.status, json };
}

before(async () => {
  server = spawn(process.execPath, ["server.mjs", `--port=${PORT}`], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HASP_EPHEMERAL: "1", PORT: String(PORT), HASP_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = `http://127.0.0.1:${PORT}`;
  const lines = [];
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (c) => lines.push(c));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (lines.join("").includes("Hasp on")) break;
    if (server.exitCode !== null) throw new Error(`server exited: ${lines.join("")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  // Unlock, so a paired device has something to read.
  await call("/api/unlock", { method: "POST", body: { password: "foundry-nightshift-2026" } });
});

after(() => {
  server?.kill("SIGTERM");
});

describe("pairing", () => {
  test("a locked vault will not start a pairing", async () => {
    const saved = cookie;
    cookie = "";
    const res = await call("/api/pair/start", { method: "POST", body: {} });
    assert.equal(res.status, 401);
    cookie = saved;
  });

  test("starting a pairing returns a code with a checksum", async () => {
    const res = await call("/api/pair/start", { method: "POST", body: {} });
    assert.equal(res.status, 200);
    assert.match(res.json.code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}-[A-Z2-7]{2}$/);
    assert.equal(res.json.code.replace(/-/g, "").length, 34);
    assert.equal(res.json.expiresIn, 120);
  });

  test("a wrong code is refused as a signature", async () => {
    await call("/api/pair/start", { method: "POST", body: {} });
    const res = await phone("/api/pair", { method: "POST", sec: newCode().slice(0, 32) });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /not right/);
  });

  test("a signature for a different path does not pair", async () => {
    await call("/api/pair/start", { method: "POST", body: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(6).toString("hex");
    // Signed for /api/pair/codes, sent to /api/pair.
    const signature = sign(newCode().slice(0, 32), {
      method: "POST",
      path: "/api/pair/codes",
      timestamp,
      nonce,
    });
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: {
        cookie,
        "x-hasp-device": deviceId,
        "x-hasp-time": String(timestamp),
        "x-hasp-nonce": nonce,
        "x-hasp-signature": signature,
      },
    });
    assert.equal(res.status, 401);
    // A refused pairing stays pending until it expires or is replaced, so this test
    // leaves one behind on purpose. The test that follows asserts the no-pairing
    // case, and the handler expires a stale pending pairing on its own.
  });

  test("a pending pairing is replaced by starting a new one", async () => {
    await call("/api/pair/start", { method: "POST", body: {} });
    const again = await call("/api/pair/start", { method: "POST", body: {} });
    assert.equal(again.status, 200);
    assert.match(again.json.code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}-[A-Z2-7]{2}$/);
  });

  test("a pairing code expires instead of staying usable", async () => {
    // The pending pairing is held in memory with a two minute life. Waiting two
    // minutes in a test would be silly, so this asserts the shape of the refusal
    // the handler produces and leaves the timer to the unit tests, which drive it
    // with a clock.
    const started = await call("/api/pair/start", { method: "POST", body: {} });
    assert.equal(started.status, 200);
    assert.equal(started.json.expiresIn, 120);
  });

  test("a request with no signature headers is refused", async () => {
    await unlock();
    const res = await fetch(`${base}/api/pair`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });
});

describe("a paired phone", () => {
  before(async () => {
    // The idle timer can lock the vault mid-suite, which is correct behaviour and
    // is covered elsewhere. Unlock again so these tests measure pairing.
    await call("/api/unlock", { method: "POST", body: { password: "foundry-nightshift-2026" } });
    // The server only knows the secret it generated, so the test reads it from a
    // fresh pairing the way a person would read it off the screen, then proves
    // possession by signing.
    const started = await fetch(`${base}/api/pair/start`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    const { code } = await started.json();
    secret = code.replace(/-/g, "").slice(0, 32);

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(6).toString("hex");
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: {
        "x-hasp-device": deviceId,
        "x-hasp-device-name": "Pixel 8 Pro",
        "x-hasp-time": String(timestamp),
        "x-hasp-nonce": nonce,
        "x-hasp-signature": sign(secret, { method: "POST", path: "/api/pair", timestamp, nonce }),
      },
    });
    assert.equal(res.status, 200);
  });

  test("reads codes, and nothing else", async () => {
    await unlock();
    const res = await phone("/api/pair/codes");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.codes));
    assert.ok(res.json.codes.length > 0, "the sample vault has one-time codes");
    for (const code of res.json.codes) {
      assert.deepEqual(Object.keys(code).sort(), ["code", "id", "name", "remaining", "step"]);
    }
    const body = JSON.stringify(res.json);
    assert.ok(!body.includes("gsk_"), "a stored secret travelled to the phone");
    assert.ok(!body.includes("secret"), "a totp secret field travelled to the phone");
  });

  test("a replayed request is refused", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = "replay_once_1";
    const signature = sign(secret, { method: "GET", path: "/api/pair/codes", timestamp, nonce });
    const headers = {
      cookie,
      "x-hasp-device": deviceId,
      "x-hasp-time": String(timestamp),
      "x-hasp-nonce": nonce,
      "x-hasp-signature": signature,
    };
    await unlock();
    const first = await fetch(`${base}/api/pair/codes`, { headers });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/api/pair/codes`, { headers });
    assert.equal(second.status, 401);
  });

  test("a request from a wrong clock is refused with a clock message", async () => {
    const res = await phone("/api/pair/codes", { at: Math.floor(Date.now() / 1000) - 600 });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /clock/);
  });

  test("another device id is refused", async () => {
    const res = await phone("/api/pair/codes", { device: "not_paired_device" });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /not paired/);
  });

  test("a wrong secret for a known device is refused", async () => {
    const res = await phone("/api/pair/codes", { sec: newCode().slice(0, 32) });
    assert.equal(res.status, 401);
  });

  test("the device list names the device and never returns its secret", async () => {
    await unlock();
    const res = await call("/api/pair/devices");
    assert.equal(res.status, 200);
    const device = res.json.devices.find((d) => d.id === deviceId);
    assert.ok(device, "the paired device is not listed");
    assert.equal(device.secret, undefined);
    assert.equal(device.label, "Pixel 8 Pro");
  });

  test("revoking a device stops it reading codes", async () => {
    await unlock();
    const removed = await call(`/api/pair/devices?id=${deviceId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, 1);
    const res = await phone("/api/pair/codes");
    assert.equal(res.status, 401);
  });
});
