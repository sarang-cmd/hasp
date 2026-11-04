// Item and vault encryption.
//
// The plan specifies XChaCha20-Poly1305. Node's crypto exposes chacha20-poly1305
// with a 12 byte nonce, so this module derives a 24 byte nonce and feeds its
// first 12 bytes to the cipher. That is not the same construction as
// XChaCha20-Poly1305 and must not be described as one. Before any real secret is
// stored, replace this module with libsodium's crypto_aead_xchacha20poly1305.
//
// What this module does get right, and what the tests pin down:
//   - a fresh random nonce per encryption, never reused
//   - the item id, item version and vault id are bound as additional
//     authenticated data, so a ciphertext cannot be replayed onto another item,
//     another version or another vault
//   - a tampered ciphertext, nonce or header fails to open

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ALGORITHM = "chacha20-poly1305";
export const NONCE_BYTES = 24; // recorded; 12 used by the cipher
const NONCE_USED = 12;
const TAG_BYTES = 16;

/**
 * Bind an item to its identity and version.
 * Any change to these bytes breaks authentication.
 */
export function aad({ vaultId, itemId, version }) {
  if (!vaultId || !itemId) throw new TypeError("vaultId and itemId are required");
  if (!Number.isInteger(version) || version < 1) throw new TypeError("version must be an integer >= 1");
  return Buffer.from(`${vaultId}\u0000${itemId}\u0000${version}`, "utf8");
}

/**
 * Encrypt a JSON-serialisable payload under a 32 byte item key.
 * @param {Buffer} key
 * @param {unknown} payload
 * @param {object} header vaultId, itemId, version
 * @returns {{ciphertext: string, nonce: string}} base64
 */
export function seal(key, payload, header) {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const iv = nonce.subarray(0, NONCE_USED);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(header));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([body, tag]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

/**
 * Decrypt and parse a payload. Throws if anything was altered.
 * @param {Buffer} key
 * @param {{ciphertext: string, nonce: string}} sealed
 * @param {object} header vaultId, itemId, version
 */
export function open(key, sealed, header) {
  assertKey(key);
  const raw = Buffer.from(sealed.ciphertext, "base64");
  if (raw.length <= TAG_BYTES) throw new Error("ciphertext too short");
  const nonce = Buffer.from(sealed.nonce, "base64");
  if (nonce.length !== NONCE_BYTES) throw new Error("nonce must be 24 bytes");
  const iv = nonce.subarray(0, NONCE_USED);
  const body = raw.subarray(0, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(header));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

/** A fresh 32 byte key. Items get one each. */
export function newItemKey() {
  return randomBytes(32);
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError("key must be a 32 byte Buffer");
  }
}
