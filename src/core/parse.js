// Import parsing. Plan section 6.
//
// Three sources, in the order the plan asks for: Google Keep (JSON first, HTML
// fallback), one-time code exports (otpauth URIs and plain text), and password
// manager CSV. Everything runs locally on the raw text. This module never
// touches the network, which is what makes the import claim honest.
//
// Each candidate carries a confidence score per field. Anything under 0.7 goes
// to manual review, per the plan.

import { parseOtpauth } from "./totp.js";
import { looksLikeBackupCode, parseBlock } from "./backup-codes.js";

export const REVIEW_THRESHOLD = 0.7;

/**
 * Known key shapes. Order matters: the first match wins, so longer and more
 * specific prefixes come first.
 * Each entry: brand slug, human service name, host, and the pattern.
 */
export const KEY_SHAPES = [
  { brand: "groq", service: "Groq", host: "console.groq.com", re: /^gsk_(?:[a-z]{3,8}_)?[A-Za-z0-9]{12,}$/ },
  { brand: "stripe", service: "Stripe", host: "dashboard.stripe.com", re: /^sk_live_[A-Za-z0-9]{16,}$/, env: "live" },
  { brand: "stripe", service: "Stripe", host: "dashboard.stripe.com", re: /^sk_test_[A-Za-z0-9]{16,}$/, env: "staging" },
  { brand: "stripe", service: "Stripe", host: "dashboard.stripe.com", re: /^rk_live_[A-Za-z0-9]{16,}$/, env: "live" },
  { brand: "github", service: "GitHub", host: "github.com", re: /^gh[pousr]_[A-Za-z0-9]{30,}$/ },
  { brand: "anthropic", service: "Anthropic", host: "console.anthropic.com", re: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  // OpenAI comes after Anthropic on purpose: its shape would otherwise swallow
  // every sk-ant- key.
  { brand: "openai", service: "OpenAI", host: "platform.openai.com", re: /^sk-(?:proj-)?[A-Za-z0-9_-]{20,}$/ },
  { brand: "neon", service: "Neon", host: "console.neon.tech", re: /^postgres(?:ql)?:\/\/[^\s]+$/ },
  { brand: "supabase", service: "Supabase", host: "supabase.com", re: /^sbp_[A-Za-z0-9]{20,}$/ },
  { brand: "resend", service: "Resend", host: "resend.com", re: /^re_[A-Za-z0-9_]{16,}$/ },
  { brand: "aws", service: "AWS", host: "aws.amazon.com", re: /^AKIA[0-9A-Z]{16}$/ },
  { brand: "aws", service: "AWS", host: "aws.amazon.com", re: /^ASIA[0-9A-Z]{16}$/ },
  // Loose shapes last: a bare alphanumeric run would otherwise swallow every
  // prefixed key above.
  { brand: "cloudflare", service: "Cloudflare", host: "dash.cloudflare.com", re: /^[A-Za-z0-9_-]{40}$/, loose: true },
  { brand: "vercel", service: "Vercel", host: "vercel.com", re: /^[A-Za-z0-9]{24}$/, loose: true },
].map((s) => ({ ...s, regex: s.re, re: undefined }));

/** Environment words that show up in note text. */
const ENV_WORDS = [
  [/\bprod(?:uction)?\b/i, "prod"],
  [/\blive\b/i, "live"],
  [/\bstag(?:ing)?\b/i, "staging"],
  [/\bdev(?:elopment)?\b/i, "dev"],
];

/** A note line that reads like a secret rather than prose. */
function wordsOf(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Detect a key shape in a token.
 * @param {string} token
 * @returns {{brand: string, service: string, host: string, env?: string, confidence: number}|null}
 */
export function detectKey(token) {
  const t = String(token).trim().replace(/^["'`]+|["'`,.]+$/g, "");
  if (t.length < 16) return null;
  for (const shape of KEY_SHAPES) {
    if (!shape.regex.test(t)) continue;
    // An 18 character key is implausible; treat a near miss as review-worthy
    // rather than certain.
    const long = t.length >= 24;
    if (shape.loose) {
      // A bare alphanumeric run collides with ordinary text, so it always lands
      // in manual review, per plan section 6.
      return { brand: shape.brand, service: shape.service, host: shape.host, env: shape.env, confidence: 0.55 };
    }
    return {
      brand: shape.brand,
      service: shape.service,
      host: shape.host,
      env: shape.env,
      // A well shaped but short token is more likely a truncated paste than a
      // key, so it goes to review instead of being trusted.
      confidence: long ? 0.96 : 0.62,
    };
  }
  return null;
}

/**
 * Best guess environment from free text. Defaults to empty, never to prod:
 * guessing production on an unlabelled key is the expensive mistake.
 */
export function detectEnv(text) {
  for (const [re, env] of ENV_WORDS) if (re.test(text)) return env;
  return "";
}

/**
 * Parse one blob of free text, such as a Google Keep note body.
 * @param {string} text
 * @param {{title?: string, updatedAt?: string}} [meta]
 */
export function parseNote(text, meta = {}) {
  const raw = String(text || "");
  const title = (meta.title || "").trim();
  const tokens = raw.split(/[\s,;]+/).map((t) => t.replace(/^["'`(]+|["'`).,;]+$/g, ""));

  // One-time codes come from URIs, and win over key shapes when present.
  const otpauth = tokens.find((t) => t.startsWith("otpauth://"));
  if (otpauth) {
    try {
      const parsed = parseOtpauth(otpauth);
      return [candidate({
        name: parsed.issuer || parsed.account || title || "One-time code",
        brand: brandFor(parsed.issuer),
        service: parsed.issuer,
        host: "",
        type: "totp",
        env: "",
        value: "",
        totp: parsed,
        notes: stripSecrets(raw),
        confidence: { type: 0.99, service: parsed.issuer ? 0.9 : 0.4 },
        source: meta,
      })];
    } catch {
      // Fall through: an unparseable URI is still worth showing as a note.
    }
  }

  // A block of short code-like lines is a backup code set.
  const blockLines = raw.split(/\r?\n/).filter((l) => looksLikeBackupCode(l.replace(/^\s*\d+[.)]\s*/, "")));
  if (blockLines.length >= 4) {
    const codes = parseBlock(raw);
    const brand = hostBrand(raw) || brandFor(title);
    return [candidate({
      name: title || `${brandName(brand) || "Account"} backup codes`,
      brand,
      service: brandName(brand) || "",
      host: hostFor(brand),
      type: "backup-codes",
      env: "",
      value: "",
      codes,
      notes: stripSecrets(raw),
      confidence: { type: 0.94, service: brand ? 0.85 : 0.3 },
      source: meta,
    })];
  }

  // Otherwise look for a key.
  for (const token of tokens) {
    const hit = detectKey(token);
    if (!hit) continue;
    return [candidate({
      name: title || `${hit.service} key`,
      brand: hit.brand,
      service: hit.service,
      host: hit.host,
      type: "api-key",
      env: hit.env || detectEnv(raw),
      value: token,
      notes: stripSecrets(raw),
      confidence: {
        type: 0.97,
        service: 0.95,
        env: hit.env ? 0.9 : detectEnv(raw) ? 0.75 : 0.35,
        value: hit.confidence,
      },
      source: meta,
    })];
  }

  // Nothing recognisable. Keep it as a note so the user does not lose the text.
  return [candidate({
    name: title || "Note",
    brand: hostBrand(raw) || "",
    service: "",
    host: "",
    type: "note",
    env: detectEnv(raw),
    value: "",
    notes: raw,
    confidence: { type: 0.4, value: 0.2 },
    source: meta,
  })];
}

/**
 * Remove anything that looks like a secret from text kept as a note.
 * The plan's rule: a review screen may show the source, a stored note may not
 * carry the secret twice.
 */
export function stripSecrets(text) {
  return String(text)
    // Private key blocks go first: they span lines and would defeat a word split.
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "")
    .split(/\s+/)
    // Anything with a key prefix goes even when it is too short to be a key.
    .filter((tok) => !detectKey(tok) && !/^(?:gsk|sk|pk|rk|gh[pousr]|re|sbp|AKIA|ASIA)_/.test(tok))
    .filter((tok) => !/^[A-Z2-7]{16,}={0,2}$/.test(tok)) // base32 runs
    .filter((tok) => !/^postgres(?:ql)?:\/\//.test(tok)) // connection strings
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2000);
}

/**
 * Google Keep Takeout JSON. Accepts both the flat array and the
 * `{"notes": [...]}` wrapper that some exports use.
 * @param {string} jsonText
 * @returns {{candidates: object[], source: string, notes: number}}
 */
export function parseKeepJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("That file is not valid JSON. Try the HTML export instead.");
  }
  const notes = Array.isArray(data) ? data : data.notes || data.items || [];
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Error("No notes found in that JSON export.");
  }
  const candidates = [];
  for (const note of notes) {
    const title = note.title || "";
    const body = note.textContent || note.text || "";
    const when = note.userEditedTimestampUsec
      ? new Date(Number(note.userEditedTimestampUsec) / 1000).toISOString()
      : note.createdTimestampUsec
      ? new Date(Number(note.createdTimestampUsec) / 1000).toISOString()
      : undefined;
    if (!body.trim() && !title.trim()) continue;
    for (const c of parseNote(`${title}\n${body}`, { title, updatedAt: when })) {
      candidates.push(c);
    }
  }
  return { candidates, source: "Google Keep, JSON", notes: notes.length };
}

/**
 * Google Keep Takeout HTML. Notes are `<div class="note">` blocks with a heading
 * and a body; the class names have been stable for years, but this is why the
 * plan says to test fixtures per export version.
 * @param {string} html
 */
export function parseKeepHtml(html) {
  const notes = [];
  const blockRe = /<div[^>]+class="[^"]*\bnote\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class="[^"]*\bnote\b|$)/gi;
  let m;
  while ((m = blockRe.exec(String(html))) !== null) {
    const block = m[1];
    const heading = /<div[^>]+class="[^"]*heading[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const content = /<div[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const text = decodeEntities(stripTags((content || heading || [null, ""])[1] || ""));
    const title = decodeEntities(stripTags((heading || [null, ""])[1] || ""));
    const time = /<span[^>]+class="[^"]*heading-date[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    if (!text.trim() && !title.trim()) continue;
    notes.push({ title: title.trim(), body: text.trim(), raw: (time || [null, ""])[1] });
  }
  if (notes.length === 0) {
    throw new Error("No notes found. This looks like a different Keep export format.");
  }
  const candidates = [];
  for (const n of notes) {
    for (const c of parseNote(`${n.title}\n${n.body}`, { title: n.title })) candidates.push(c);
  }
  return { candidates, source: "Google Keep, HTML", notes: notes.length };
}

/**
 * One-time code exports. Handles otpauth:// lines (plain text, Aegis, andOTP,
 * and 2FAS "plain" exports all produce these) plus bare `issuer:account:secret`
 * lines that some tools write.
 * @param {string} text
 */
export function parseOtpExport(text) {
  const lines = String(text).split(/\r?\n/);
  const candidates = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("otpauth://")) {
      try {
        const parsed = parseOtpauth(trimmed);
        candidates.push(candidate({
          name: parsed.issuer || parsed.account || "One-time code",
          brand: brandFor(parsed.issuer),
          service: parsed.issuer,
          host: hostFor(brandFor(parsed.issuer)),
          type: "totp",
          env: "",
          value: "",
          totp: parsed,
          notes: "",
          confidence: { type: 0.99, service: parsed.issuer ? 0.9 : 0.4 },
          source: { title: parsed.issuer || parsed.account, updatedAt: undefined },
        }));
        continue;
      } catch {
        // keep scanning
      }
    }
    const bare = /^([^:]{2,40}):([^:]{2,80}):([A-Z2-7\s]{16,})$/i.exec(trimmed);
    if (bare) {
      const secret = bare[3].replace(/\s+/g, "").toUpperCase();
      candidates.push(candidate({
        name: `${bare[1].trim()} ${bare[2].trim()}`.trim(),
        brand: brandFor(bare[1]),
        service: bare[1].trim(),
        host: hostFor(brandFor(bare[1])),
        type: "totp",
        env: "",
        value: "",
        totp: { issuer: bare[1].trim(), account: bare[2].trim(), secret, digits: 6, step: 30 },
        notes: "",
        confidence: { type: 0.8, service: 0.7 },
        source: {},
      }));
    }
  }
  if (candidates.length === 0) {
    throw new Error("No one-time codes found. Expect one otpauth:// link per line.");
  }
  return { candidates, source: "One-time code export", notes: candidates.length };
}

/**
 * Password manager CSV. Reads the header, maps common column names, and falls
 * back to a plain three column layout.
 * @param {string} text
 */
export function parseCsv(text) {
  const rows = csvRows(String(text));
  if (rows.length < 2) throw new Error("That CSV has no data rows.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };
  const iName = col("name", "title", "account");
  const iUrl = col("url", "website", "login_uri", "host");
  const iUser = col("username", "login", "email");
  const iPass = col("password", "secret", "value", "key");
  const iNotes = col("notes", "note", "extra");
  if (iPass === -1) throw new Error("No password or secret column found in that CSV.");

  const candidates = [];
  for (const row of rows.slice(1)) {
    const value = (row[iPass] || "").trim();
    if (!value) continue;
    const name = (iName >= 0 ? row[iName] : "") || (iUrl >= 0 ? row[iUrl] : "") || "Imported secret";
    const url = iUrl >= 0 ? row[iUrl] : "";
    const brand = hostBrand(url) || brandFor(name);
    const hit = detectKey(value);
    candidates.push(candidate({
      name: name.trim(),
      brand: hit?.brand || brand,
      service: hit?.service || brandName(brand),
      host: hit?.host || hostFor(brand),
      type: "api-key",
      env: detectEnv(`${name} ${url}`),
      value,
      notes: [iUser >= 0 ? row[iUser] : "", iNotes >= 0 ? row[iNotes] : ""].filter(Boolean).join(", "),
      confidence: { type: 0.85, service: brand ? 0.8 : 0.4, value: hit ? 0.95 : 0.6 },
      source: { title: name.trim() },
    }));
  }
  if (candidates.length === 0) throw new Error("No secrets found in that CSV.");
  return { candidates, source: "Password manager CSV", notes: rows.length - 1 };
}

/**
 * Duplicate detection against items already in the vault. Uses the value, which
 * means it runs after decryption on the client and never leaves the device.
 * @param {object[]} candidates
 * @param {object[]} existing decrypted items
 * @returns {Set<number>} indexes into candidates that duplicate an existing item
 */
export function findDuplicates(candidates, existing) {
  const seen = new Map();
  for (const item of existing) {
    if (item.value) seen.set(item.value, item.id);
    if (item.type === "totp" && item.totp?.secret) seen.set(item.totp.secret, item.id);
  }
  const dupes = new Set();
  candidates.forEach((c, i) => {
    const key = c.type === "totp" ? c.totp?.secret : c.value;
    if (key && seen.has(key)) dupes.add(i);
  });
  return dupes;
}

/** Shape one candidate, filling defaults and flagging what needs review. */
export function candidate(fields) {
  const confidence = fields.confidence || {};
  const lowest = Math.min(
    ...["type", "service", "value", "env"].map((k) => (confidence[k] === undefined ? 1 : confidence[k]))
  );
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: fields.name || "Untitled",
    brand: fields.brand || "",
    service: fields.service || "",
    host: fields.host || "",
    type: fields.type || "api-key",
    env: fields.env || "",
    value: fields.value || "",
    notes: fields.notes || "",
    totp: fields.totp,
    codes: fields.codes,
    tags: [],
    source: fields.source || {},
    confidence,
    needsReview: lowest < REVIEW_THRESHOLD,
  };
}

/* ---------------------------------------------------------------- helpers */

import { BRAND_BY_HOST, BRAND_NAMES, GENERIC_NAMES } from "./brands.js";

/**
 * Brand names longest first, so "GitHub" is tested before "Git" and
 * "Cloudflare" before "Cloud". Built once at load.
 */
const NAME_ORDER = Object.entries(BRAND_NAMES)
  .filter(([, label]) => label.length >= 3)
  .sort((a, b) => b[1].length - a[1].length);

/** Brand slug for a hostname or a free text mention. */
export function hostBrand(text) {
  const s = String(text || "").toLowerCase();
  for (const [host, slug] of BRAND_BY_HOST) {
    if (s.includes(host)) return slug;
  }
  return "";
}

/** Brand slug for a service or issuer name. Whole words only. */
export function brandFor(name) {
  if (!name) return "";
  const n = String(name).toLowerCase().trim();
  for (const [slug, label] of NAME_ORDER) {
    if (GENERIC_NAMES.has(slug)) continue;
    const l = label.toLowerCase();
    if (n === l) return slug;
    // Match a leading whole word: "Groq production" and "Groq" both count,
    // "Grocery" does not.
    if (n.startsWith(`${l} `) || n.startsWith(`${l}-`) || n.startsWith(`${l},`)) return slug;
  }
  return "";
}

export function brandName(slug) {
  return BRAND_NAMES[slug] || "";
}

export function hostFor(slug) {
  for (const [host, s] of BRAND_BY_HOST) if (s === slug) return host;
  return "";
}

function stripTags(html) {
  return String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Minimal RFC 4180 reader. Handles quoted fields containing commas and newlines. */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((f) => f.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.length > 0)) rows.push(row);
  return rows;
}
