// Tests for the phone client.
//
// Two things in this app must agree with the server byte for byte or nothing works:
// the signature, and the checksum on a pairing code. A disagreement fails as "not
// accepted" with no clue why, which is why these are compared against the server
// implementation rather than against a recorded value.
//
// The address validator is the other half. It decides where a secret is sent, and
// the whole point of this design is that a secret never leaves the local network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sign as phoneSign, signingBase } from "../mobile/src/sign.js";
import { checksum2, sha256, hmacSha256 } from "../mobile/src/checksum.js";
import { codeToSecret, cleanCode } from "../mobile/src/code.js";
import { normaliseAddress, newDeviceId } from "../mobile/src/api.js";
import { signingBase as serverBase, sign as serverSign, newPairingSecret, formatCode } from "../src/core/pairing.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("signature agreement", () => {
  test("the signed string is the same on both sides", () => {
    const fields = {
      deviceId: "pixel_8_pro",
      method: "get",
      path: "/api/pair/codes",
      timestamp: 1800000000,
      nonce: "a1b2c3d4e5f6",
    };
    assert.equal(signingBase(fields), serverBase(fields));
    // The method is upper cased by both, so a caller that sends "get" still agrees.
    assert.match(serverBase(fields), /^pixel_8_pro\nGET\n/);
  });

  test("the same request produces the same signature on both sides", async () => {
    const secret = newPairingSecret().slice(0, 32);
    // Many samples, because the base32 alphabet and the HMAC key length interact
    // and one passing case is not evidence.
    for (let i = 0; i < 25; i += 1) {
      const fields = {
        deviceId: `device_${i}`,
        method: "GET",
        path: "/api/pair/codes",
        timestamp: 1800000000 + i,
        nonce: `nonce${String(i).padStart(9, "0")}`,
      };
      assert.equal(await phoneSign(secret, fields), serverSign(secret, fields), `sample ${i}`);
    }
  });

  test("a signature is 64 lowercase hex characters", async () => {
    const sig = await phoneSign("A".repeat(32), {
      deviceId: "device_1",
      method: "GET",
      path: "/x",
      timestamp: 1,
      nonce: "abcdefgh",
    });
    assert.match(sig, /^[0-9a-f]{64}$/);
  });
});

describe("checksum agreement", () => {
  test("the two character checksum matches the server for many codes", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newPairingSecret();
      assert.equal(checksum2(code.slice(0, 32)), code.slice(32), `sample ${i}`);
    }
  });

  test("sha256 matches the known digest of an empty input", () => {
    // The published value, so a broken round constant or padding rule is caught
    // rather than merely being consistent with itself.
    const hex = [...sha256(new Uint8Array(0))].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("sha256 agrees with node across message lengths", () => {
    // Lengths on both sides of the block boundary and the padding boundary, because
    // an off by one in the padding produces a plausible but wrong digest.
    const enc = new TextEncoder();
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
      const text = "a".repeat(length);
      const mine = [...sha256(enc.encode(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
      assert.equal(mine, createHash("sha256").update(text).digest("hex"), `length ${length}`);
    }
  });

  test("hmac matches node for the same key and message", () => {
    const enc = new TextEncoder();
    for (const message of ["", "a", "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", "x".repeat(200)]) {
      const mine = [...hmacSha256(enc.encode("hasp-pairing-checksum"), enc.encode(message))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const node = createHmac("sha256", "hasp-pairing-checksum").update(message).digest("hex");
      assert.equal(mine, node, `message length ${message.length}`);
    }
  });
});

describe("reading a pairing code", () => {
  test("a formatted code is accepted however it was typed", () => {
    const code = newPairingSecret();
    const secret = code.slice(0, 32);
    for (const typed of [
      formatCode(code),
      formatCode(code).toLowerCase(),
      formatCode(code).replace(/-/g, " "),
      code,
    ]) {
      assert.equal(codeToSecret(typed), secret, JSON.stringify(typed));
    }
  });

  test("a wrong character is refused", () => {
    const code = newPairingSecret();
    const wrong = (code[0] === "A" ? "B" : "A") + code.slice(1);
    assert.equal(codeToSecret(formatCode(wrong)), null);
  });

  test("the wrong length is refused", () => {
    const code = newPairingSecret();
    assert.equal(codeToSecret(code.slice(0, 30)), null);
    assert.equal(codeToSecret(code + "AA"), null);
    assert.equal(codeToSecret(""), null);
    assert.equal(codeToSecret(null), null);
  });

  test("a stray character is dropped, and the code is read as it was typed", () => {
    // Dropping the character restores the original code, which is the useful
    // behaviour: someone who pastes a code that picked up a zero still pairs. What
    // must not happen is that the stray character is treated as part of the secret.
    const code = newPairingSecret();
    const withJunk = `${code.slice(0, 10)}0${code.slice(10)}`;
    assert.equal(cleanCode(withJunk).length, 34, "the junk character was not dropped");
    assert.equal(codeToSecret(withJunk), code.slice(0, 32));
  });

  test("a dropped character is not silently repaired", () => {
    // The opposite case: a character missing from the middle leaves 33 characters,
    // and that is refused rather than padded.
    const code = newPairingSecret();
    const short = code.slice(0, 10) + code.slice(11);
    assert.equal(cleanCode(short).length, 33);
    assert.equal(codeToSecret(short), null);
  });

  test("cleaning removes case, spaces and dashes", () => {
    assert.equal(cleanCode("ab-cd 23"), "ABCD23");
    assert.equal(cleanCode("AB CD"), "ABCD");
    assert.equal(cleanCode(null), "");
  });
});

describe("the address a secret is sent to", () => {
  test("a private address is accepted", () => {
    const cases = {
      "192.168.1.20": "http://192.168.1.20:3000",
      "192.168.1.20:3000": "http://192.168.1.20:3000",
      "10.0.0.5": "http://10.0.0.5:3000",
      "172.16.4.4": "http://172.16.4.4:3000",
      "172.31.255.254": "http://172.31.255.254:3000",
      "169.254.1.1": "http://169.254.1.1:3000",
      "vault.local": "http://vault.local:3000",
      phonebook: "http://phonebook:3000",
      "http://192.168.1.20:8080": "http://192.168.1.20:8080",
    };
    for (const [input, want] of Object.entries(cases)) {
      assert.equal(normaliseAddress(input), want, input);
    }
  });

  test("a public address is refused, because the channel is plain http", () => {
    for (const input of [
      "example.com",
      "https://example.com",
      "8.8.8.8",
      "172.32.0.1",
      "172.15.0.1",
      "11.0.0.1",
      "1.1.1.1:3000",
    ]) {
      assert.equal(normaliseAddress(input), null, `${input} was accepted`);
    }
  });

  test("localhost is refused, because on a phone it means the phone", () => {
    assert.equal(normaliseAddress("localhost:3000"), null);
    assert.equal(normaliseAddress("LOCALHOST"), null);
  });

  test("a path, credentials or another scheme is refused", () => {
    for (const input of [
      "192.168.1.20/app",
      "http://user:pass@192.168.1.20",
      "ftp://192.168.1.20",
      "file:///etc/passwd",
      "192.168.1.20?x=1",
      "",
      null,
    ]) {
      assert.equal(normaliseAddress(input), null, JSON.stringify(input));
    }
  });

  test("a bad port is refused", () => {
    for (const input of ["192.168.1.20:0", "192.168.1.20:70000", "192.168.1.20:abc", "192.168.1.20:1:2"]) {
      assert.equal(normaliseAddress(input), null, input);
    }
  });

  test("a device id is random and usable in a header", () => {
    const ids = new Set(Array.from({ length: 40 }, () => newDeviceId()));
    assert.equal(ids.size, 40);
    for (const id of ids) {
      assert.match(id, /^[a-z0-9]{8,18}$/);
    }
  });
});

describe("the mobile app", () => {
  test("names the cost of the plain http channel on the pairing screen", () => {
    const app = readFileSync(join(ROOT, "mobile/www/app.js"), "utf8");
    assert.match(app, /plain http/i, "the pairing screen does not mention the channel");
    assert.match(app, /local network/i);
  });

  test("asks for nothing but an address and a code", () => {
    const app = readFileSync(join(ROOT, "mobile/www/app.js"), "utf8");
    const inputs = [...app.matchAll(/<input id="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(inputs.sort(), ["address", "code"]);
  });

  test("every item field rendered into html is escaped", () => {
    // A code name comes from the vault and can contain markup, so an interpolation
    // of an item field inside an HTML template is a cross site scripting bug.
    // Selector lookups are excluded: they build a query string, not markup.
    const app = readFileSync(join(ROOT, "mobile/www/app.js"), "utf8");
    const htmlParts = app.split("querySelector").join("\u0000");
    const raw = [...htmlParts.matchAll(/\$\{\s*c\.(name|code)\s*\}/g)].map((m) => m[0]);
    assert.deepEqual(raw, [], `unescaped item fields in html: ${raw.join(", ")}`);
    assert.ok(app.includes("esc(c.name)"), "the code name is not escaped");
    assert.ok(app.includes("esc(group(c.code))"), "the code is not escaped");
  });

  test("the capacitor config and the shell files exist", () => {
    for (const file of ["capacitor.config.json", "package.json", "www/index.html", "www/app.css", "www/app.js", "src/api.js", "src/sign.js", "src/code.js", "src/checksum.js", "src/render.js"]) {
      assert.ok(existsSync(join(ROOT, "mobile", file)), `missing: mobile/${file}`);
    }
    const config = JSON.parse(readFileSync(join(ROOT, "mobile/capacitor.config.json"), "utf8"));
    assert.equal(config.appId, "dev.hasp.app");
    assert.equal(config.webDir, "www");
  });

  test("the app does not bundle a totp implementation", () => {
    // Guessing the next code locally would need the totp secret on the phone, which
    // is the one thing this design keeps off it.
    const files = ["www/app.js", "src/api.js", "src/sign.js", "src/code.js", "src/checksum.js"];
    for (const file of files) {
      const source = readFileSync(join(ROOT, "mobile", file), "utf8");
      assert.ok(!/hotp|totp\(/i.test(source), `${file} computes codes`);
    }
  });
});
