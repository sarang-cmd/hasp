// Turns parsed authenticator accounts into vault candidates.
//
// The two parsers on either side of this file speak different shapes. An
// authenticator export is a flat list of accounts with an issuer, an account name
// and a secret. A vault candidate is an item with a type, a host, a brand and a
// confidence flag. This is the seam, and it is the only place the two meet.
//
// It lives outside both so each side keeps its own tests and neither grows a
// dependency on the other.

import { secretStrength } from "./authenticator.js";
import { brandFor, candidate, hostBrand, hostFor } from "./parse.js";

/** RFC 4226 asks for at least 128 bits, which is 16 bytes or 26 base32 characters. */
const MIN_SECRET_BYTES = 16;

/**
 * One account -> one candidate.
 *
 * `needsReview` is set for the cases where importing quietly would be a lie: a
 * secret too short to be a real one, an account with no issuer to name it, or an
 * HOTP account, which needs a counter the interface does not offer yet.
 */
export function accountToCandidate(acct, { origin = "" } = {}) {
  const name = (acct.issuer || acct.name || acct.account || "One-time code").trim();
  const account = (acct.account || "").trim();

  // The issuer is the company, so it is what the brand and host come from.
  // brandFor matches whole words only, which keeps "Grocery" from matching Groq.
  const brand = acct.issuer ? brandFor(acct.issuer) || hostBrand(acct.issuer) : "";
  const host = brand ? hostFor(brand) : "";

  const bytes = secretStrength(acct.secret);
  const reasons = [];
  if (bytes < MIN_SECRET_BYTES) reasons.push(`secret decodes to ${bytes} bytes`);
  if (!acct.issuer) reasons.push("no issuer, so the item has no company name");
  if (acct.kind === "hotp") reasons.push("counter based, which needs a counter to work");

  // The account name is the useful disambiguator when one issuer has several
  // accounts, so it goes in the notes rather than being dropped.
  const notes = [];
  if (account && account !== name) notes.push(`Account: ${account}`);
  if (origin) notes.push(`Imported from ${origin}`);

  // Built through the shared constructor, which owns the id, the tag list and the
  // confidence threshold. Hand-rolling the shape produced candidates with no id,
  // and the review screen compares ids against the duplicate list.
  const base = candidate({
    name: account && name !== account ? `${name} (${account})` : name,
    brand,
    service: name,
    host,
    type: "totp",
    env: "",
    value: "",
    notes: notes.join("\n"),
    totp: {
      secret: acct.secret,
      digits: acct.digits,
      step: acct.period,
      algorithm: acct.algorithm,
      ...(acct.kind === "hotp" ? { counter: acct.counter } : {}),
    },
    codes: [],
    // A one-time code has no environment and no value of its own, so those fields
    // are not evidence of anything and should not pull the score down.
    confidence: { type: 1, service: name ? 1 : 0.4, value: 1, env: 1 },
  });

  return {
    ...base,
    tags: ["imported"],
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
  };
}

/**
 * A whole import -> candidates plus a line of context for the review screen.
 *
 * Skipped entries are carried through rather than dropped. A person who expected
 * eleven codes and got nine needs to know which two are missing and why.
 */
export function authImportToCandidates(result) {
  if (!result || result.error) {
    return { candidates: [], source: "", summary: result?.error || "Nothing to import", skipped: [] };
  }
  const candidates = result.accounts.map((acct) => accountToCandidate(acct, { origin: result.source }));
  const flagged = candidates.filter((c) => c.needsReview).length;
  const parts = [`${candidates.length} one-time code${candidates.length === 1 ? "" : "s"}`];
  if (result.source) parts.push(`from ${result.source}`);
  if (result.skipped?.length) parts.push(`${result.skipped.length} skipped`);
  if (flagged) parts.push(`${flagged} need review`);
  return {
    candidates,
    source: result.source,
    summary: parts.join(", "),
    skipped: result.skipped || [],
  };
}

/**
 * Does this text look like an authenticator export rather than a Keep note or a
 * password manager CSV?
 *
 * Deliberately conservative, and matched to the dialects the parser actually
 * recognises: 2FAS, Aegis, Google Authenticator, Microsoft Authenticator,
 * Bitwarden, Raivo, or any text carrying otpauth links.
 *
 * JSON is parsed before it is judged. A regex would claim a truncated file and then
 * hand the parser something it cannot read, which reports "0 imported" for what is
 * really a damaged download.
 */
export function looksLikeAuthenticator(text) {
  const raw = String(text || "");
  if (/otpauth:\/\//i.test(raw)) return true;
  if (!/^\s*[[{]/.test(raw)) return false;

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }

  if (Array.isArray(json)) {
    // Raivo: a bare array of rows that each carry a secret.
    return json.some((r) => r && typeof r === "object" && (r.secret || r.Secret));
  }
  if (!json || typeof json !== "object") return false;

  return Boolean(
    Array.isArray(json.services) || // 2FAS
      json.db?.entries || // Aegis
      json.otp_parameters || // Google Authenticator
      json.AuthenticatorAccounts || // Microsoft Authenticator
      (Array.isArray(json.items) && json.items.some((i) => i?.login?.totp)), // Bitwarden
  );
}
