// Reading a pairing code.
//
// The vault shows 34 base32 characters, grouped in fours. This is the same check as
// parseCode() in src/core/pairing.js, and it has to be, or the phone accepts a code
// the vault will not verify.

import { checksum2 } from "./checksum.js";

/** Strip the formatting a person introduces: case, dashes, spaces. */
export function cleanCode(input) {
  return String(input || "").replace(/[^A-Z2-7]/gi, "").toUpperCase();
}

/** The 32 character secret from a typed code, or null if the shape is wrong. */
export function codeToSecret(input) {
  const clean = cleanCode(input);
  if (clean.length !== 34) return null;
  const secret = clean.slice(0, 32);
  return checksum2(secret) === clean.slice(32) ? secret : null;
}
