// Time-based one-time codes, RFC 6238, built on RFC 4226 HOTP.
//
// Implemented here rather than pulled from a dependency because the whole code
// path is short, auditable and covered by the test vectors in RFC 6238 appendix
// B. A real client should still prefer a reviewed library.

import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 secret. Case insensitive, ignores spaces and
 * padding, which is what authenticator exports contain.
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=]+/g, "");
  if (clean.length === 0) throw new Error("empty base32 secret");
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Encode bytes as base32, no padding. Used to mint new secrets. */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * HOTP counter-based code.
 * @param {Buffer} key
 * @param {number} counter
 * @param {number} digits
 */
export function hotp(key, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  // 64 bit big endian counter. Beyond 2^53 this loses precision, which lands in
  // the year 44618 at 30 second steps.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Current code plus how long it stays valid.
 * @param {string} secret base32
 * @param {{digits?: number, step?: number, algorithm?: string, at?: number}} [opts]
 * @returns {{code: string, remaining: number, step: number, period: number}}
 */
export function totp(secret, opts = {}) {
  const { digits = 6, step = 30, at = Date.now() } = opts;
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / step);
  const elapsed = (at / 1000) % step;
  return {
    code: hotp(key, counter, digits),
    remaining: Math.ceil(step - elapsed),
    step,
    period: step,
  };
}

/**
 * Verify a submitted code, allowing one step of clock drift either way.
 * @returns {boolean}
 */
export function verify(secret, code, opts = {}) {
  const { digits = 6, step = 30, at = Date.now(), window = 1 } = opts;
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / step);
  const given = String(code).replace(/\s+/g, "");
  for (let drift = -window; drift <= window; drift += 1) {
    if (hotp(key, counter + drift, digits) === given) return true;
  }
  return false;
}

/**
 * Parse an otpauth:// URI into the fields the vault stores.
 * @param {string} uri
 */
export function parseOtpauth(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("not a URL");
  }
  if (url.protocol !== "otpauth:") throw new Error("not an otpauth URI");
  if (url.hostname !== "totp") throw new Error(`unsupported otpauth type: ${url.hostname}`);
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const [issuerPart, accountPart] = label.includes(":") ? label.split(":") : [undefined, label];
  const p = url.searchParams;
  const secret = p.get("secret");
  if (!secret) throw new Error("otpauth URI has no secret");
  base32Decode(secret); // validate before accepting
  return {
    issuer: (p.get("issuer") || issuerPart || "").trim(),
    account: (accountPart || "").trim(),
    secret: secret.toUpperCase().replace(/[\s=]+/g, ""),
    digits: Number(p.get("digits") || 6),
    step: Number(p.get("period") || 30),
    algorithm: (p.get("algorithm") || "SHA1").toUpperCase(),
  };
}
