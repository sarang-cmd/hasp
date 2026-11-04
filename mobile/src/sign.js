// HMAC-SHA256 for the pairing signature.
//
// WebCrypto is present in every iOS and Android web view from the last several
// years. A locked down view can lack subtle crypto, and in that case the app says
// so instead of quietly signing with something weaker.

const encoder = new TextEncoder();

/** hex string -> bytes. */
export function hexToBytes(hex) {
  const clean = String(hex || "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** bytes -> hex, always padded, so a signature is one length. */
export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The string that is signed.
 *
 * Kept byte for byte in step with signingBase() in src/core/pairing.js. If these
 * two ever disagree every request is rejected, which is at least a loud failure.
 */
export function signingBase({ deviceId, method, path, timestamp, nonce }) {
  return [deviceId, String(method || "GET").toUpperCase(), path, String(timestamp), nonce].join("\n");
}

export async function sign(secret, fields) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw Object.assign(new Error("This device cannot sign requests."), { code: "no_crypto" });
  }
  // The secret is used as the key directly, as text. The vault does the same, so
  // the two agree without a base32 decode step on either side.
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await subtle.sign("HMAC", key, encoder.encode(signingBase(fields)));
  return bytesToHex(mac);
}
