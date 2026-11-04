// Backup code sets. A set is a list of single-use codes. The plan's rule is
// that the clipboard never holds a whole set, and the count of remaining codes
// is visible without revealing any of them.

import { randomInt } from "node:crypto";

/** Crockford style alphabet: no I, L, O, U, so codes survive being read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP = 5;

/**
 * Mint a set of codes.
 * @param {{count?: number, groups?: number, prefix?: string}} [opts]
 * @returns {string[]}
 */
export function generateSet({ count = 10, groups = 2, prefix = "" } = {}) {
  if (count < 1 || count > 100) throw new RangeError("count must be 1 to 100");
  if (groups < 1 || groups > 5) throw new RangeError("groups must be 1 to 5");
  const set = new Set();
  while (set.size < count) set.add(oneCode(groups, prefix));
  return [...set];
}

function oneCode(groups, prefix) {
  const parts = [];
  for (let g = 0; g < groups; g += 1) {
    let chunk = "";
    for (let i = 0; i < GROUP; i += 1) chunk += ALPHABET[randomInt(ALPHABET.length)];
    parts.push(chunk);
  }
  return (prefix ? `${prefix}-` : "") + parts.join("-");
}

/** Loose shape check, for the import parser's confidence score. */
export function looksLikeBackupCode(value) {
  return /^[A-Z0-9]{4,6}(-[A-Z0-9]{4,6}){1,4}$/i.test(String(value).trim());
}

/**
 * Parse a pasted block of codes, one per line, tolerating list numbering and
 * stray whitespace that survives a copy from a support page.
 * @param {string} text
 * @returns {string[]}
 */
export function parseBlock(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]\s*|[-*\u2022]\s*)/, "").trim())
    .filter((line) => line.length > 0 && looksLikeBackupCode(line))
    .map((line) => line.toUpperCase());
}

/**
 * How many codes in a set are still unused.
 * Codes are stored with a `usedAt` marker rather than being deleted, so the set
 * keeps its shape after a code is spent.
 */
export function remaining(codes) {
  return codes.filter((c) => !c.usedAt).length;
}
