// Key wrapping. The vault key is random and is stored wrapped by the password
// key, never in clear. Two wraps exist in the model, one for the password and
// one for a future passkey; this preview implements the password wrap and leaves
// the passkey column empty rather than pretending.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const WRAP_AAD = Buffer.from("hasp:vault-key:v1", "utf8");

/**
 * Wrap a 32 byte vault key under a 32 byte key-encryption key.
 * @returns {{wrapped: string, nonce: string}} base64
 */
export function wrapKey(kek, vaultKey) {
  assert32(kek, "kek");
  assert32(vaultKey, "vaultKey");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  cipher.setAAD(WRAP_AAD);
  const body = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
  return {
    wrapped: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

/**
 * Unwrap the vault key. Throws if the key-encryption key is wrong or the wrap
 * was altered.
 * @returns {Buffer} 32 byte vault key
 */
export function unwrapKey(kek, { wrapped, nonce }) {
  assert32(kek, "kek");
  const raw = Buffer.from(wrapped, "base64");
  if (raw.length !== 48) throw new Error("wrapped key has the wrong length");
  const iv = Buffer.from(nonce, "base64");
  if (iv.length !== 12) throw new Error("wrap nonce must be 12 bytes");
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAAD(WRAP_AAD);
  decipher.setAuthTag(raw.subarray(32));
  return Buffer.concat([decipher.update(raw.subarray(0, 32)), decipher.final()]);
}

function assert32(buf, name) {
  if (!Buffer.isBuffer(buf) || buf.length !== 32) {
    throw new TypeError(`${name} must be a 32 byte Buffer`);
  }
}
