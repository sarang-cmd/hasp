// logo.dev proxy.
//
// The API key for logo.dev is a secret key. It goes in an environment variable and
// is used by the server, never by the browser. If it reached the client bundle it
// would be readable by anyone with the page open, and a key that can spend someone
// else's quota is worth taking.
//
// The proxy does three things beyond forwarding:
//
//   allowlist  only the routes we intend to use, so the proxy cannot be turned into
//              an open fetch for arbitrary hosts
//   normalise  a domain or a brand slug in, a canonical host out
//   cache      a logo does not change, so a hit costs nothing. The cache is in
//              process memory with a bounded size; it is not a CDN and does not
//              pretend to be one.
//
// When no key is configured the proxy reports that cleanly. A missing key must not
// look like a broken feature: the client already has 586 vendored marks and falls
// back to them.

/** The endpoints we are willing to call. Anything else is refused, not forwarded. */
const ALLOWED_PATHS = new Set(["/", "/img", "/description", "/logo"]);

/** Bound the cache so a long-running process cannot be grown out of memory. */
const MAX_ENTRIES = 500;
const cache = new Map();

/** Read the key from the environment. Never from a request, never from a file. */
export function keyFromEnv(env = process.env) {
  const key = env.LOGO_DEV_KEY || env.LOGO_DEV_SECRET || "";
  return typeof key === "string" && key.startsWith("sk_") ? key : "";
}

/** The public (publishable) key, if one is set. This one is safe in a bundle. */
export function publicKeyFromEnv(env = process.env) {
  const key = env.LOGO_DEV_PUBLIC_KEY || "";
  return typeof key === "string" && key.startsWith("pk_") ? key : "";
}

/**
 * Turn whatever the caller passed into a canonical host.
 *
 * Accepts "groq", "groq.com", "console.groq.com", "https://groq.com/x". Rejects
 * anything that is not a plausible hostname, so the proxy cannot be pointed at a
 * local address or an arbitrary path.
 */
export function toHost(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw || raw.length > 253) return null;

  let host;
  if (/^https?:\/\//.test(raw)) {
    // A full URL is parsed, not split: URL() handles the path, the query and the
    // port correctly, and rejects anything that is not actually a URL.
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      host = u.hostname;
    } catch {
      return null;
    }
  } else {
    // A bare host must be only a host. Slashes, colons, at signs and query marks
    // mean the caller passed something else, and guessing at the first segment is
    // how a traversal or a protocol smuggle slips through.
    if (/[\s/\\@?#:]/.test(raw)) return null;
    host = raw;
  }

  host = host.replace(/\.$/, "");
  if (!host) return null;

  // Check the name BEFORE appending a suffix. "localhost" must be refused as
  // localhost, not turned into localhost.com and then judged innocent.
  const reserved = /^(localhost|local|internal|intranet|test|invalid|example|lan|home|corp)$/;
  const firstLabel = host.split(".")[0];
  if (reserved.test(firstLabel) && !host.includes(".")) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)\./.test(host)) return null;

  if (!host.includes(".")) host = `${host}.com`;

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  // Four dotted numbers is an address, not a domain. Refuse every private and
  // loopback range; a logo proxy that fetches 169.254.169.254 is an SSRF.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (/^(\d+|0x[0-9a-f]+)\./.test(host)) return null;
  if (host.split(".").length === 2 && /^(\d+)$/.test(host.split(".")[0])) return null;

  return host;
}

/** A cache key that includes every parameter that changes the bytes. */
function cacheKey(host, path, params) {
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${path}|${host}|${sorted.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

/** Read a cache entry, evicting the oldest when full. */
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so a hot logo is not evicted by a cold one.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, value, ttlMs) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ...value, expires: Date.now() + ttlMs });
}

/** Test hook. Also used on shutdown. */
export function clearCache() {
  cache.clear();
}

export const cacheSize = () => cache.size;

/**
 * Build the upstream request without performing it, so the shape can be tested
 * without a network.
 */
export function buildRequest(input, { key, path = "/", params = {} } = {}) {
  if (!key) return { error: "not_configured" };
  if (!ALLOWED_PATHS.has(path)) return { error: "path_not_allowed" };

  const host = toHost(input);
  if (!host) return { error: "invalid_host" };

  const url = new URL(`https://img.logo.dev/${host}`);
  url.searchParams.set("token", key);
  for (const [k, v] of Object.entries(params)) {
    // Only pass the parameters the vendor documents. An arbitrary query string is
    // how a proxy becomes a way to smuggle something else upstream.
    if (["size", "format", "theme", "fallback", "retina"].includes(k) && v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }
  return { url: url.toString(), host };
}

/**
 * Fetch a logo, through the cache.
 *
 * Returns { status, contentType, body } or { error }. A caller turns this into a
 * response; a test stubs fetch and checks what was asked for.
 */
export async function fetchLogo(input, options = {}) {
  const key = options.key ?? keyFromEnv();
  const built = buildRequest(input, { key, path: options.path ?? "/", params: options.params ?? {} });
  if (built.error) return built;

  const cacheable = built.url;
  const hit = cacheGet(cacheable);
  if (hit) return { ...hit, cached: true };

  let res;
  try {
    res = await (options.fetchImpl ?? fetch)(built.url, {
      headers: { accept: "image/*" },
      // The key is in the query string because that is the vendor's shape; it is
      // never logged here, and the error paths below strip it.
      redirect: "follow",
    });
  } catch {
    return { error: "upstream_unreachable" };
  }

  if (!res.ok) {
    return { error: "upstream_error", status: res.status };
  }

  const contentType = res.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) {
    // A HTML error page with a 200 is a real thing that happens. Refusing it stops
    // us caching markup and serving it as an image.
    return { error: "not_an_image" };
  }

  const body = Buffer.from(await res.arrayBuffer());
  // A logo is small. An enormous response means something is wrong upstream, and
  // caching it would fill the process.
  if (body.length > 2_000_000) return { error: "too_large" };

  const value = { status: 200, contentType, body };
  cacheSet(cacheable, value, 24 * 60 * 60 * 1000);
  return value;
}
