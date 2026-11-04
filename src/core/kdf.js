// Key derivation for the vault.
//
// The plan calls for Argon2id with 64 MiB and 3 passes. The browser and desktop
// clients can meet that. This server-side preview runs on the platform's own
// crypto, which offers scrypt and PBKDF2 only, so it derives with scrypt and
// labels the result honestly. A vault records which KDF produced it, so a
// client can refuse to open one it cannot derive.
//
// Do not read this file as a claim that Argon2id is in use.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** Parameters recorded with every vault so the derivation is reproducible. */
export const KDF = Object.freeze({
  algorithm: "scrypt",
  N: 2 ** 16, // 65536, about 64 MiB of memory at r=8
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  version: 1,
});

const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/**
 * Derive the password key from the master password and a salt.
 * @param {string} password
 * @param {Buffer} salt
 * @param {object} [params] KDF parameters, defaults to KDF
 * @returns {Promise<Buffer>} 32 byte key
 */
export async function deriveKey(password, salt, params = KDF) {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }
  if (!Buffer.isBuffer(salt) || salt.length < 8) {
    throw new TypeError("salt must be a Buffer of at least 8 bytes");
  }
  if (params.algorithm !== "scrypt") {
    throw new Error(`unsupported KDF: ${params.algorithm}`);
  }
  return scryptAsync(password, salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** A fresh random salt for a new vault. */
export function newSalt() {
  return randomBytes(KDF.saltLength);
}

/** The KDF parameters to record alongside a vault. Never secret. */
export function kdfParams() {
  return { ...KDF };
}

/**
 * Constant time comparison for two byte strings.
 * @returns {boolean}
 */
export function bytesEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
