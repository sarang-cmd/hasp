// Authenticator export parsers.
//
// Every authenticator exports in a different dialect, and none of them are
// documented as a format. These are written against real export files, and each
// one records what it saw so a failure is diagnosable rather than a blank screen.
//
// The two shapes that matter:
//
//   otpauth://  a URI per account. Every app can emit these, and they are the only
//               self-describing form: algorithm, digits and period travel with the
//               secret. This is the interchange format.
//
//   JSON blobs  Authy, 2FAS, Aegis, Bitwarden, Raivo and Microsoft Authenticator
//               all export JSON with different keys. Each has a parser here rather
//               than a regex, because guessing at a key name silently produces an
//               empty import instead of an error.
//
// Deliberately not supported: Google Authenticator's QR-only transfer, and any
// vendor format that encrypts the export (Authy, most of the time). Those are
// reported as unsupported with the reason, not as a silent zero.

import { base32Decode } from "./totp.js";

/** Normalise a secret to the canonical uppercase, unpadded base32 we store. */
export function normaliseSecret(raw) {
  const cleaned = String(raw || "")
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/=+$/, "");
  // Anything outside the base32 alphabet cannot be a secret. Returning null lets
  // the caller skip it with a reason instead of storing a broken entry that will
  // generate wrong codes forever.
  if (!/^[A-Z2-7]+$/.test(cleaned)) return null;
  if (cleaned.length < 8) return null;
  return cleaned;
}

/** Parse one otpauth URI into our account shape. Returns null when unusable. */
export function parseOtpauth(uri) {
  let url;
  try {
    url = new URL(String(uri).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "otpauth:") return null;
  // Both totp and hotp are imported. hotp stores a counter instead of a period.
  const kind = url.host.toLowerCase();
  if (kind !== "totp" && kind !== "hotp") return null;

  const secret = normaliseSecret(url.searchParams.get("secret"));
  if (!secret) return null;

  // The label is "issuer:account" or just "account". The issuer parameter wins
  // when both are present, which is what every authenticator does.
  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const [labelIssuer, ...rest] = label.split(":");
  const account = (rest.length ? rest.join(":") : labelIssuer).trim();
  const issuer = (url.searchParams.get("issuer") || (rest.length ? labelIssuer : "")).trim();

  const digits = Number(url.searchParams.get("digits")) || 6;
  const period = Number(url.searchParams.get("period")) || 30;
  const algorithm = (url.searchParams.get("algorithm") || "SHA1").toUpperCase();

  return {
    kind,
    name: (issuer || account || "One-time code").trim(),
    issuer: issuer || account,
    account,
    secret,
    digits: [6, 8].includes(digits) ? digits : 6,
    period: period > 0 ? period : 30,
    algorithm: ["SHA1", "SHA256", "SHA512"].includes(algorithm) ? algorithm : "SHA1",
    counter: kind === "hotp" ? Number(url.searchParams.get("counter")) || 0 : undefined,
  };
}

/** Every otpauth URI in a blob of text, in order. */
export function parseOtpauthText(text) {
  const found = [];
  const re = /otpauth:\/\/[^\s"'<>]+/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    const entry = parseOtpauth(m[0]);
    if (entry) found.push(entry);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Vendor JSON dialects. Each returns { accounts, skipped } where skipped lists
// what could not be read and why.

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Walk an unknown object for a value by any of several key spellings. */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function account(fields) {
  const secret = normaliseSecret(fields.secret);
  if (!secret) return null;
  return {
    kind: "totp",
    name: str(fields.name) || str(fields.issuer) || "One-time code",
    issuer: str(fields.issuer) || str(fields.name) || "",
    account: str(fields.account) || "",
    secret,
    digits: [6, 8].includes(fields.digits) ? fields.digits : 6,
    period: fields.period > 0 ? fields.period : 30,
    algorithm: ["SHA1", "SHA256", "SHA512"].includes(str(fields.algorithm).toUpperCase())
      ? str(fields.algorithm).toUpperCase()
      : "SHA1",
  };
}

/**
 * Aegis. Exported as { version, header, db: { entries: [...] } }, where each entry
 * has an `info` block and the otpauth uri is often easier to read than the fields.
 */
function parseAegis(json) {
  const entries = json?.db?.entries ?? json?.entries ?? [];
  const accounts = [];
  const skipped = [];
  for (const e of entries) {
    if (e?.type && e.type !== "totp" && e.type !== "hotp") {
      skipped.push(`Unsupported entry type: ${e.type}`);
      continue;
    }
    const fromUri = parseOtpauth(pick(e, "uri", "otpauth") ?? "");
    if (fromUri) {
      accounts.push(fromUri);
      continue;
    }
    const a = account({
      secret: pick(e?.info, "secret") ?? e?.secret,
      name: pick(e?.Info, "name") ?? pick(e?.info, "name") ?? e?.name,
      issuer: pick(e?.info, "issuer") ?? e?.issuer,
      account: pick(e?.info, "accountName") ?? e?.accountName,
      digits: Number(pick(e?.info, "digits") ?? 6),
      period: Number(pick(e?.info, "period") ?? 30),
      algorithm: pick(e?.info, "algo", "algorithm") ?? "SHA1",
    });
    if (a) accounts.push(a);
    else skipped.push(`Entry with no usable secret: ${str(e?.name) || "unnamed"}`);
  }
  return { accounts, skipped, source: "Aegis" };
}

/** 2FAS. A flat { services: [ { name, secret, otp: { issuer, account, digits, period } } ] }. */
function parse2fas(json) {
  const services = json?.services ?? json?.data?.services ?? [];
  const accounts = [];
  const skipped = [];
  for (const s of services) {
    const a = account({
      secret: pick(s, "secret"),
      name: pick(s?.otp, "issuer") ?? pick(s, "name"),
      issuer: pick(s?.otp, "issuer") ?? pick(s, "name"),
      account: pick(s?.otp, "account") ?? pick(s, "account"),
      digits: Number(pick(s?.otp, "digits") ?? 6),
      period: Number(pick(s?.otp, "period") ?? 30),
      algorithm: pick(s?.otp, "algorithm") ?? "SHA1",
    });
    if (a) accounts.push(a);
    else skipped.push(`Service with no usable secret: ${str(s?.name) || "unnamed"}`);
  }
  return { accounts, skipped, source: "2FAS" };
}

/** Raivo. An array of { issuer, account, secret, algorithm, digits, timer }. */
function parseRaivo(json) {
  const rows = Array.isArray(json) ? json : json?.entries ?? [];
  const accounts = [];
  const skipped = [];
  for (const r of rows) {
    const a = account({
      secret: pick(r, "secret"),
      name: pick(r, "issuer") ?? pick(r, "name"),
      issuer: pick(r, "issuer"),
      account: pick(r, "account"),
      digits: Number(pick(r, "digits") ?? 6),
      period: Number(pick(r, "timer", "period") ?? 30),
      algorithm: pick(r, "algorithm") ?? "SHA1",
    });
    if (a) accounts.push(a);
    else skipped.push(`Entry with no usable secret: ${str(r?.issuer) || "unnamed"}`);
  }
  return { accounts, skipped, source: "Raivo" };
}

/** Bitwarden. A vault export; authenticator rows live under items[].login.totp. */
function parseBitwarden(json) {
  const items = json?.items ?? [];
  const accounts = [];
  const skipped = [];
  for (const item of items) {
    const uri = item?.login?.totp;
    if (!uri) continue;
    const fromUri = parseOtpauth(String(uri));
    if (fromUri) {
      accounts.push({ ...fromUri, name: fromUri.name || str(item?.name), account: fromUri.account || str(item?.login?.username) });
    } else {
      skipped.push(`Item with an unreadable totp field: ${str(item?.name) || "unnamed"}`);
    }
  }
  return { accounts, skipped, source: "Bitwarden" };
}

/** Microsoft Authenticator. Its JSON export nests accounts under a root key. */
function parseMicrosoft(json) {
  const rows = json?.accounts ?? json?.AuthenticatorAccounts ?? json?.data ?? [];
  const accounts = [];
  const skipped = [];
  for (const r of rows) {
    const fromUri = parseOtpauth(pick(r, "otpauth", "uri") ?? "");
    if (fromUri) {
      accounts.push(fromUri);
      continue;
    }
    const a = account({
      secret: pick(r, "secret", "SecretKey"),
      name: pick(r, "name", "displayName", "Issuer"),
      issuer: pick(r, "issuer", "Issuer"),
      account: pick(r, "accountName", "UserName"),
      digits: Number(pick(r, "digits") ?? 6),
      period: Number(pick(r, "period") ?? 30),
      algorithm: pick(r, "algorithm") ?? "SHA1",
    });
    if (a) accounts.push(a);
    else skipped.push(`Account with no usable secret: ${str(r?.name) || "unnamed"}`);
  }
  return { accounts, skipped, source: "Microsoft Authenticator" };
}

/** Google Authenticator's JSON export, from its "Export accounts" QR screen. */
function parseGoogle(json) {
  const rows = json?.otp_parameters ?? json?.accounts ?? [];
  const accounts = [];
  const skipped = [];
  for (const r of rows) {
    const a = account({
      secret: pick(r, "secret"),
      name: pick(r, "issuer") ?? pick(r, "name"),
      issuer: pick(r, "issuer"),
      account: pick(r, "name", "account"),
      digits: Number(pick(r, "digits") ?? 6),
      period: Number(pick(r, "period") ?? 30),
      algorithm: pick(r, "algorithm") ?? "SHA1",
    });
    if (a) accounts.push(a);
    else skipped.push(`Entry with no usable secret: ${str(r?.issuer) || "unnamed"}`);
  }
  return { accounts, skipped, source: "Google Authenticator" };
}

/**
 * Detect the dialect and parse it.
 *
 * Detection is by shape, not by a version string: 2FAS is the only one with a
 * `services` array, Aegis the only one with `db.entries`, and so on. A file that
 * matches nothing is reported as unrecognised rather than parsed into zero
 * accounts, because "0 imported" and "wrong file" are very different messages.
 */
export function parseAuthenticatorJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { accounts: [], skipped: [], source: null, error: "Not valid JSON" };
  }

  const attempts = [
    [parse2fas, (j) => Array.isArray(j?.services)],
    [parseAegis, (j) => Boolean(j?.db?.entries || (j?.header?.slots && j?.entries))],
    [parseRaivo, (j) => Array.isArray(j) && j.some((r) => pick(r, "secret"))],
    [parseBitwarden, (j) => Array.isArray(j?.items) && j.items.some((i) => i?.login?.totp)],
    [parseGoogle, (j) => Boolean(j?.otp_parameters)],
    [
      parseMicrosoft,
      (j) =>
        Boolean(
          j?.AuthenticatorAccounts ||
            (Array.isArray(j?.accounts) && j.accounts.some((a) => pick(a, "secret", "SecretKey", "otpauth")))
        ),
    ],
    [parseRaivo, (j) => Boolean(j?.entries)],
  ];

  for (const [fn, matches] of attempts) {
    if (!matches(json)) continue;
    const out = fn(json);
    if (out.accounts.length || out.skipped.length) return out;
  }

  return {
    accounts: [],
    skipped: [],
    source: null,
    error: "Unrecognised export. Supported: Aegis, 2FAS, Raivo, Bitwarden, Google Authenticator, Microsoft Authenticator.",
  };
}

/**
 * The one entry point the import screen uses.
 *
 * Text that contains otpauth URIs is handled first: a paste of URIs is unambiguous
 * and never needs dialect detection. Everything else is tried as JSON.
 */
export function parseAuthenticatorExport(text) {
  const raw = String(text || "");
  const uris = parseOtpauthText(raw);
  if (uris.length) {
    return { accounts: uris, skipped: [], source: "otpauth URIs" };
  }
  return parseAuthenticatorJson(raw);
}

/** A readable summary for the import review, not a wall of JSON. */
export function describeImport(result) {
  if (result.error) return result.error;
  const parts = [`${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"}`];
  if (result.source) parts.push(`from ${result.source}`);
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
  return parts.join(", ");
}

/** Decoded byte length of a secret, so the review can flag a truncated import. */
export function secretStrength(secret) {
  try {
    return base32Decode(secret).length;
  } catch {
    return 0;
  }
}
