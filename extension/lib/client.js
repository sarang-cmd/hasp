// The only place this extension talks to the vault.
//
// Two rules hold everywhere in this file:
//
// 1. The vault address is loopback. A manifest host permission cannot be narrowed
//    to a port, so the check has to happen here: a stored setting of
//    "https://example.com" must be refused rather than used, or the extension
//    becomes a way to send a session cookie somewhere useful.
//
// 2. No secret is ever stored. The session lives in a HttpOnly cookie that this
//    extension cannot read, which is deliberate: there is nothing to steal from
//    extension storage, and revoking the session revokes the extension too.

const ORIGIN_KEY = "hasp.origin";
export const DEFAULT_ORIGIN = "http://127.0.0.1:3000";

/** Hostnames that mean this machine, and nothing else. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Validate a vault address and return it without a trailing slash.
 *
 * Returns null for anything that is not an http loopback origin. https on loopback
 * is refused too: the server does not serve TLS, so accepting it would produce a
 * confusing connection error instead of a clear one.
 */
export function normaliseOrigin(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!LOOPBACK.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  // A path or query is not part of an origin, so it is dropped rather than kept.
  return `${url.protocol}//${url.host}`;
}

export async function getOrigin() {
  const stored = await chrome.storage.local.get(ORIGIN_KEY);
  return normaliseOrigin(stored[ORIGIN_KEY]) || DEFAULT_ORIGIN;
}

export async function setOrigin(value) {
  const clean = normaliseOrigin(value);
  if (!clean) throw new Error("The vault address must be http on 127.0.0.1 or localhost.");
  await chrome.storage.local.set({ [ORIGIN_KEY]: clean });
  return clean;
}

/**
 * One request to the vault.
 *
 * `credentials: "include"` carries the session cookie, so the extension sees the
 * same session the browser tab does. A locked vault answers 401, which is passed
 * through as a typed error rather than an empty list, so the interface can say
 * "unlock it" instead of "no items".
 */
export async function request(path, { method = "GET", body } = {}) {
  const origin = await getOrigin();
  const res = await fetch(`${origin}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    const err = new Error("The vault is locked.");
    err.code = "locked";
    throw err;
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // A non-JSON body from something that is not the vault, usually a proxy page.
  }
  if (!res.ok) {
    const err = new Error(data?.error || `The vault answered ${res.status}.`);
    err.code = res.status;
    throw err;
  }
  return data;
}

/** The session, so the popup knows whether to show the gate or the list. */
export const session = () => request("/api/session");

/** The whole item list. */
export const state = () => request("/api/state");

/** Unlock. The password crosses loopback once and is not stored. */
export const unlock = (password) => request("/api/unlock", { method: "POST", body: { password } });

/** Lock, which invalidates the cookie this extension was relying on. */
export const lock = () => request("/api/lock", { method: "POST", body: {} });

/**
 * Matches for a hostname, from the same list the page shows.
 *
 * Matching is done here rather than on the server because the vault has no search
 * endpoint and adding one would mean a query string on a route that returns
 * secrets. Three passes, most exact first: the full host, the registrable part,
 * then the item's service name inside the host. `api.stripe.com` should find Stripe.
 */
/** Lowercase, letters and digits only, so "Cloudflare" and "cloud-flare" agree. */
const normalise = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function matchHost(items, hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  if (!host) return [];

  // The registrable label: the last two segments of a host, or the first label of a
  // two segment host. "api.stripe.com" -> "stripe.com", "stripe.com" -> "stripe.com".
  const parts = host.split(".");
  const base = parts.length >= 2 ? parts.slice(-2).join(".") : host;

  const scored = items.map((item) => {
    const itemHost = String(item.host || "").toLowerCase().replace(/^www\./, "");
    const itemBase = itemHost ? itemHost.split(".").slice(-2).join(".") : "";
    let score = 0;
    if (itemHost && itemHost === host) score = 100;
    else if (itemBase && itemBase === base) score = 80;
    // A shared first label is not evidence: "example.org" and
    // "unrelated.example.net" both start with "example". Service names match only
    // when the whole host is the service, which is how someone names a key for a
    // product that has no obvious domain. A subdomain of some other site is not
    // that, so "unrelated.example.net" does not match an item called Unrelated.
    else if (
      itemHost === "" &&
      item.service &&
      normalise(item.service) === normalise(host.replace(/\.[a-z]{2,}$/, ""))
    )
      score = 40;

    return { item, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

/**
 * The host of a tab, so the popup can offer what is relevant before you type.
 *
 * Returns "" for pages that have no host to match: a chrome:// page, the new tab
 * page, or a tab the extension has no access to.
 */
export function hostOf(url) {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return "";
    return hostname;
  } catch {
    return "";
  }
}
