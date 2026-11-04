// Pairing a phone with a vault on the same network.
//
// The hard question is not how to move bytes. It is what a phone is allowed to
// have. A vault that makes no outbound request and keeps one encrypted file does
// not become a cloud service because a phone asked nicely, so this file is built
// around three constraints:
//
// 1. A phone is paired in person, with a code shown on the desktop screen. There is
//    no account, no discovery broadcast and no server in the middle.
// 2. A paired phone can read one thing: the current one-time codes. Never a stored
//    secret value, never a backup code set, never the vault file. The route that
//    serves it builds its response from a whitelist, so an item field added later
//    does not leak by default.
// 3. The channel carries a 30 second code over an ordinary LAN connection. That is
//    stated plainly rather than described as encrypted, because it is not.
//
// Replay is the attack that matters on a shared network: an observer who cannot
// forge a signature can still copy one. Every request carries a timestamp and a
// nonce, and both are checked.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 20 bytes is 160 bits, which is above the 128 bit floor and short enough to type. */
const SECRET_BYTES = 20;

/** base32 of 20 bytes is exactly 32 characters, plus two of checksum. */
const SECRET_CHARS = 32;

/** How far a request timestamp may be from now, in seconds. */
export const MAX_SKEW = 120;

/** How many recent nonces are remembered per device. */
const MAX_NONCES = 512;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    // Mask to the width that can still be shifted safely. JavaScript bitwise
    // operators truncate to 32 bits, so accumulating 20 bytes in one number
    // silently produced extra characters rather than a wrong code.
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * A checksum, so a typo is caught before pairing rather than after.
 *
 * Two base32 characters is 10 bits, which turns a wrong code into a failed check
 * roughly 999 times in 1000 instead of pairing the phone to nothing and producing a
 * lifetime of confusing signature failures.
 */
function checksum(secret) {
  const digest = createHmac("sha256", "hasp-pairing-checksum").update(secret).digest();
  return base32(digest).slice(0, 2);
}

/** A new pairing secret, with its checksum, as one string. */
export function newPairingSecret() {
  // 20 bytes is exactly 32 base32 characters, so there is nothing to pad or cut.
  const secret = base32(randomBytes(SECRET_BYTES));
  return secret + checksum(secret);
}

/**
 * "ABCDEFGHIJ..." -> "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZAB-CDEF-GH".
 *
 * The secret is 32 characters, which is eight groups of four. The checksum is the
 * last two. Grouping the whole string in fours left a two character tail at the
 * end, which never matched the shape the input field and the documentation show.
 */
export function formatCode(value) {
  const clean = String(value || "").replace(/[^A-Z2-7]/gi, "").toUpperCase();
  const groups = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups.join("-");
}

/**
 * Validate and normalise a typed code.
 *
 * Case, dashes and spaces are all removed, because a person copying a code off a
 * screen will introduce all three. The checksum is the actual check.
 *
 * Returns the secret without the checksum, which is what a signature is keyed on.
 */
export function parseCode(input) {
  const clean = String(input || "").replace(/[^A-Z2-7]/gi, "").toUpperCase();
  if (clean.length !== SECRET_CHARS + 2) return null;
  const secret = clean.slice(0, SECRET_CHARS);
  const check = clean.slice(SECRET_CHARS);
  if (checksum(secret) !== check) return null;
  return secret;
}

/** The string that is signed, in one place so both sides cannot disagree. */
function signingBase({ deviceId, method, path, timestamp, nonce }) {
  return [deviceId, String(method || "GET").toUpperCase(), path, String(timestamp), nonce].join("\n");
}

export { signingBase };

/**
 * Sign a request.
 *
 * The body is deliberately not included. The one route a phone may call carries no
 * body, and a signature that covers an empty string invites a reader to assume it
 * covers a body that was never checked.
 */
export function sign(secret, { deviceId, method, path, timestamp, nonce }) {
  return createHmac("sha256", secret)
    .update(signingBase({ deviceId, method, path, timestamp, nonce }))
    .digest("hex");
}

/**
 * Verify a request.
 *
 * `seen` is a Map of deviceId -> Map of nonce -> timestamp, owned by the caller so
 * this stays a pure function. Expired entries are pruned here rather than by a
 * timer, because a timer that stops leaves a cache that grows without bound.
 */
export function verify(secret, request, { now = Math.floor(Date.now() / 1000), seen = new Map() } = {}) {
  const { deviceId, method, path, timestamp, nonce, signature } = request || {};

  if (!deviceId || !nonce || !signature) return { ok: false, error: "malformed" };
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return { ok: false, error: "malformed" };
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return { ok: false, error: "malformed" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, error: "malformed" };

  // A clock that is wrong is a common failure, and the message should say so. A
  // request from the future is checked the same way as one from the past.
  if (Math.abs(now - ts) > MAX_SKEW) return { ok: false, error: "stale" };

  const expected = sign(secret, { deviceId, method, path, timestamp: ts, nonce });
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(signature), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };

  // Replay check comes after the signature, so an unauthenticated request cannot
  // burn a nonce and cause a real one to be rejected.
  let device = seen.get(deviceId);
  if (!device) {
    device = new Map();
    seen.set(deviceId, device);
  }
  if (device.has(nonce)) return { ok: false, error: "replayed" };

  device.set(nonce, ts);
  for (const [key, at] of device) {
    if (now - at > MAX_SKEW * 2) device.delete(key);
  }
  while (device.size > MAX_NONCES) device.delete(device.keys().next().value);

  return { ok: true };
}

/**
 * What a paired phone is allowed to see of an item.
 *
 * A whitelist, not a redaction. A field added to the vault later does not appear
 * here until someone adds it, which is the direction the mistake should point.
 */
export function codeView(item, { now = Date.now() } = {}) {
  if (!item || item.type !== "totp" || !item.totp?.secret) return null;
  const step = item.totp.step || 30;
  return {
    id: item.id,
    name: item.name,
    code: item.totp.code || "",
    step,
    remaining: item.totp.remaining || step - (Math.floor(now / 1000) % step),
  };
}

/** The list a phone receives, with anything unviewable dropped rather than blanked. */
export function codeList(items, options) {
  return items.map((item) => codeView(item, options)).filter(Boolean);
}

/**
 * Name a device, because a pairing list of three identical rows is not revocable.
 *
 * Anything unusual is stripped, and the length is bounded, so a device name cannot
 * be used to make a row unreadable or to carry markup.
 */
export function deviceLabel(raw) {
  const clean = String(raw || "")
    .replace(/[^\w .()-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return clean || "Unnamed device";
}
