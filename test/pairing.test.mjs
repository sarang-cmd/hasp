// Tests for pairing a phone.
//
// The pairing code is the only thing standing between a LAN and a phone that can
// read codes, so most of this file is about what is refused.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  newPairingSecret,
  formatCode,
  parseCode,
  sign,
  verify,
  codeView,
  codeList,
  deviceLabel,
  MAX_SKEW,
} from "../src/core/pairing.js";

const NOW = 1_800_000_000;
const SECRET = newPairingSecret();

const req = (over = {}) => {
  const base = {
    deviceId: "pixel_8_pro",
    method: "GET",
    path: "/api/pair/codes",
    timestamp: NOW,
    nonce: "a1b2c3d4e5f6",
    ...over,
  };
  return { ...base, signature: sign(SECRET, base) };
};

describe("the pairing code", () => {
  test("is long enough to be worth typing", () => {
    // 20 bytes is 160 bits, which is exactly 32 base32 characters, plus two of
    // checksum. The encoder used to accumulate 20 bytes in one number and produce
    // 34 characters, which is what this length pins down.
    assert.equal(SECRET.length, 34);
    assert.match(SECRET, /^[A-Z2-7]+$/);
  });

  test("is different every time", () => {
    const all = new Set(Array.from({ length: 50 }, () => newPairingSecret()));
    assert.equal(all.size, 50);
  });

  test("round trips through formatting", () => {
    const shown = formatCode(SECRET);
    // Eight groups of four for the secret, then the two checksum characters. The
    // first version grouped all 34 in fours and left a two character tail, which
    // is why the shape is asserted rather than just the separators.
    assert.match(shown, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}-[A-Z2-7]{2}$/, "the code is not grouped 4-4-4-4-4-4-4-4-2");
    assert.equal(shown.replace(/-/g, "").length, 34);
    // parseCode returns the secret without the two checksum characters.
    assert.equal(parseCode(shown), SECRET.slice(0, 32));
  });

  test("survives being retyped in lower case with spaces", () => {
    const messy = formatCode(SECRET).toLowerCase().replace(/-/g, " ");
    assert.equal(parseCode(messy), SECRET.slice(0, 32));
  });

  test("a single wrong character is caught by the checksum", () => {
    const shown = formatCode(SECRET);
    const wrong = (shown[0] === "A" ? "B" : "A") + shown.slice(1);
    assert.equal(parseCode(wrong), null);
  });

  test("a truncated or extended code is refused", () => {
    assert.equal(parseCode(SECRET.slice(0, 30)), null);
    assert.equal(parseCode(SECRET + "AA"), null);
    assert.equal(parseCode(""), null);
    assert.equal(parseCode(null), null);
  });
});

describe("signing", () => {
  test("a valid request is accepted", () => {
    assert.deepEqual(verify(SECRET, req(), { now: NOW }), { ok: true });
  });

  test("a wrong secret is refused", () => {
    const other = newPairingSecret();
    assert.equal(verify(other, req(), { now: NOW }).error, "bad_signature");
  });

  test("any covered field is bound to the signature", () => {
    const good = req();
    for (const field of ["deviceId", "method", "path", "nonce"]) {
      const tampered = { ...good, [field]: field === "method" ? "POST" : `${good[field]}x` };
      assert.equal(verify(SECRET, tampered, { now: NOW }).ok, false, `${field} was not covered`);
    }
  });

  test("a changed timestamp breaks the signature", () => {
    const good = req();
    assert.equal(verify(SECRET, { ...good, timestamp: NOW + 1 }, { now: NOW + 1 }).ok, false);
  });

  test("a request from far in the past or future is stale", () => {
    const old = req({ timestamp: NOW - MAX_SKEW - 10 });
    assert.equal(verify(SECRET, old, { now: NOW }).error, "stale");
    const future = req({ timestamp: NOW + MAX_SKEW + 10 });
    assert.equal(verify(SECRET, future, { now: NOW }).error, "stale");
  });

  test("a clock near the edge is still accepted", () => {
    const edge = req({ timestamp: NOW - MAX_SKEW + 1 });
    assert.equal(verify(SECRET, edge, { now: NOW }).ok, true);
  });

  test("a replayed request is refused once the nonce is seen", () => {
    // The attack that matters on a shared network: an observer who cannot forge a
    // signature can still copy one.
    const seen = new Map();
    const good = req();
    assert.equal(verify(SECRET, good, { now: NOW, seen }).ok, true);
    assert.equal(verify(SECRET, good, { now: NOW, seen }).error, "replayed");
  });

  test("a forged request does not burn a nonce", () => {
    // Otherwise an attacker on the network could block a real request by guessing
    // its nonce before it arrives.
    const seen = new Map();
    const good = req();
    const forged = { ...good, signature: "00".repeat(32) };
    assert.equal(verify(SECRET, forged, { now: NOW, seen }).ok, false);
    assert.equal(verify(SECRET, good, { now: NOW, seen }).ok, true, "the real request was blocked");
  });

  test("malformed requests are refused before any crypto", () => {
    for (const bad of [
      {},
      null,
      { ...req(), deviceId: "" },
      { ...req(), nonce: "" },
      { ...req(), signature: "" },
      { ...req(), deviceId: "../../etc/passwd" },
      { ...req(), timestamp: "soon" },
      { ...req(), nonce: "short" },
    ]) {
      assert.equal(verify(SECRET, bad, { now: NOW }).ok, false, JSON.stringify(bad));
    }
  });

  test("the seen map does not grow without bound", () => {
    const seen = new Map();
    for (let i = 0; i < 900; i += 1) {
      const nonce = `nonce_${String(i).padStart(10, "0")}`;
      verify(SECRET, req({ nonce }), { now: NOW + i, seen });
    }
    for (const device of seen.values()) {
      assert.ok(device.size <= 513, `a device holds ${device.size} nonces`);
    }
  });
});

describe("what a phone may see", () => {
  const item = {
    id: "i1",
    name: "GitHub",
    type: "totp",
    service: "GitHub",
    value: "a_secret_that_must_not_travel",
    notes: "private note",
    totp: { secret: "JBSWY3DPEHPK3PXP", code: "123 456", remaining: 12, step: 30, issuer: "GitHub" },
    codes: ["backup-1", "backup-2"],
  };

  test("a code view carries no secret value, notes or backup codes", () => {
    const view = codeView(item);
    assert.equal(view.code, "123 456");
    assert.equal(view.id, "i1");
    for (const leaked of ["value", "notes", "codes", "totp", "brand", "host", "issuer"]) {
      assert.equal(view[leaked], undefined, `${leaked} was sent to the phone`);
    }
    assert.ok(!JSON.stringify(view).includes("must_not_travel"), "the stored secret travelled");
    assert.ok(!JSON.stringify(view).includes("backup-1"), "a backup code travelled");
  });

  test("an item that is not a one-time code is dropped, not blanked", () => {
    assert.equal(codeView({ id: "x", type: "api-key", value: "secret" }), null);
    assert.equal(codeView({ id: "x", type: "totp", totp: {} }), null);
    assert.equal(codeView(null), null);
  });

  test("a list drops what cannot be shown rather than sending an empty row", () => {
    const list = codeList([item, { id: "x", type: "api-key", value: "s" }, { id: "y", type: "backup-codes" }]);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "i1");
  });

  test("the remaining seconds come from the clock, not the payload", () => {
    const view = codeView({ ...item, totp: { ...item.totp, remaining: 0 } }, { now: 0 });
    assert.equal(view.remaining, 30);
  });
});

describe("device names", () => {
  test("markup is stripped", () => {
    const label = deviceLabel("<script>alert(1)</script>Pixel");
    assert.ok(!/[<>]/.test(label), label);
  });

  test("a name cannot be used to make a row unreadable", () => {
    assert.ok(deviceLabel("a".repeat(500)).length <= 40);
  });

  test("an empty name still identifies the row", () => {
    assert.equal(deviceLabel(""), "Unnamed device");
    assert.equal(deviceLabel("   "), "Unnamed device");
    assert.equal(deviceLabel(null), "Unnamed device");
  });

  test("an ordinary name is left alone", () => {
    assert.equal(deviceLabel("Pixel 8 Pro"), "Pixel 8 Pro");
    assert.equal(deviceLabel("Sarang's iPhone 15"), "Sarangs iPhone 15");
  });
});
