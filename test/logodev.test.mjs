// The logo.dev proxy, tested without a network.
//
// The security-relevant behaviour is what gets refused, so most of these assert a
// rejection. A proxy that forwards anything is a request forgery primitive with a
// bill attached.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  toHost,
  buildRequest,
  fetchLogo,
  keyFromEnv,
  publicKeyFromEnv,
  clearCache,
  cacheSize,
} from "../src/core/logodev.js";

const KEY = "sk_test_placeholder_not_a_real_key_0000";

/** A fetch that records the URL and returns a small PNG-ish body. */
function stubFetch(body = Buffer.from("89504e470d0a1a0a", "hex"), { status = 200, type = "image/png" } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? type : null) },
      arrayBuffer: async () => body,
    };
  };
  return { impl, calls };
}

describe("keyFromEnv", () => {
  test("only accepts a secret-shaped key", () => {
    assert.equal(keyFromEnv({ LOGO_DEV_KEY: KEY }), KEY);
    assert.equal(keyFromEnv({ LOGO_DEV_SECRET: KEY }), KEY);
    assert.equal(keyFromEnv({ LOGO_DEV_KEY: "not-a-key" }), "", "a non sk_ value is not a secret key");
    assert.equal(keyFromEnv({}), "");
  });

  test("the public key is a separate variable", () => {
    // pk_ is safe in a bundle; sk_ is not. Keeping them in separate variables is
    // what stops one being used for the other.
    assert.equal(publicKeyFromEnv({ LOGO_DEV_PUBLIC_KEY: "pk_live_abc" }), "pk_live_abc");
    assert.equal(publicKeyFromEnv({ LOGO_DEV_PUBLIC_KEY: KEY }), "", "a secret key is not a public key");
  });
});

describe("toHost", () => {
  test("canonicalises the forms a caller might pass", () => {
    assert.equal(toHost("groq"), "groq.com");
    assert.equal(toHost("groq.com"), "groq.com");
    assert.equal(toHost("console.groq.com"), "console.groq.com");
    assert.equal(toHost("https://groq.com/path?x=1"), "groq.com");
    assert.equal(toHost("GROQ.COM"), "groq.com");
  });

  test("refuses addresses a proxy must never fetch", () => {
    // A logo proxy that fetches localhost is an SSRF primitive. These are the
    // cases that matter, not the happy path.
    assert.equal(toHost("localhost"), null);
    assert.equal(toHost("127.0.0.1"), null);
    assert.equal(toHost("10.0.0.1"), null);
    assert.equal(toHost("internal"), null);
    assert.equal(toHost("example.local"), null);
  });

  test("refuses anything that is not a hostname", () => {
    assert.equal(toHost(""), null);
    assert.equal(toHost("   "), null);
    assert.equal(toHost("a b"), null);
    assert.equal(toHost("host/path/../etc/passwd"), null);
    assert.equal(toHost("user@host.com"), null);
    assert.equal(toHost("javascript:alert(1)"), null);
    assert.equal(toHost("a".repeat(300)), null);
  });
});

describe("buildRequest", () => {
  test("puts the key in the query and the host in the path", () => {
    const r = buildRequest("groq", { key: KEY });
    assert.ok(r.url.startsWith("https://img.logo.dev/groq.com"));
    assert.ok(r.url.includes(`token=${KEY}`));
  });

  test("passes only the documented parameters", () => {
    const r = buildRequest("groq", { key: KEY, params: { size: 64, format: "png", evil: "x", url: "http://x" } });
    assert.match(r.url, /size=64/);
    assert.match(r.url, /format=png/);
    assert.ok(!r.url.includes("evil="), "an undocumented parameter was forwarded");
    assert.ok(!r.url.includes("url="), "a url parameter was forwarded");
  });

  test("refuses without a key, before any network", () => {
    assert.equal(buildRequest("groq", {}).error, "not_configured");
  });

  test("refuses an unknown path", () => {
    assert.equal(buildRequest("groq", { key: KEY, path: "/admin" }).error, "path_not_allowed");
  });

  test("refuses an invalid host", () => {
    assert.equal(buildRequest("localhost", { key: KEY }).error, "invalid_host");
  });
});

describe("fetchLogo", () => {
  beforeEach(() => clearCache());

  test("returns the image and caches it", async () => {
    const { impl, calls } = stubFetch();
    const first = await fetchLogo("groq", { key: KEY, fetchImpl: impl });
    assert.equal(first.status, 200);
    assert.equal(first.contentType, "image/png");
    assert.equal(first.cached, undefined);
    assert.equal(calls.length, 1);

    const second = await fetchLogo("groq", { key: KEY, fetchImpl: impl });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1, "the cache did not prevent a second upstream call");
    assert.equal(cacheSize(), 1);
  });

  test("a different size is a different cache entry", async () => {
    const { impl, calls } = stubFetch();
    await fetchLogo("groq", { key: KEY, params: { size: 32 }, fetchImpl: impl });
    await fetchLogo("groq", { key: KEY, params: { size: 64 }, fetchImpl: impl });
    assert.equal(calls.length, 2, "size was ignored when keying the cache");
  });

  test("refuses an HTML response rather than caching markup as an image", async () => {
    const { impl } = stubFetch(Buffer.from("<html>nope</html>"), { type: "text/html" });
    const r = await fetchLogo("groq", { key: KEY, fetchImpl: impl });
    assert.equal(r.error, "not_an_image");
    assert.equal(cacheSize(), 0, "a bad response was cached");
  });

  test("surfaces an upstream error without caching it", async () => {
    const { impl } = stubFetch(Buffer.from(""), { status: 404 });
    const r = await fetchLogo("groq", { key: KEY, fetchImpl: impl });
    assert.equal(r.error, "upstream_error");
    assert.equal(r.status, 404);
    assert.equal(cacheSize(), 0);
  });

  test("refuses an oversized body", async () => {
    const { impl } = stubFetch(Buffer.alloc(2_000_001));
    const r = await fetchLogo("groq", { key: KEY, fetchImpl: impl });
    assert.equal(r.error, "too_large");
    assert.equal(cacheSize(), 0);
  });

  test("reports a missing key rather than attempting a call", async () => {
    const { impl, calls } = stubFetch();
    const r = await fetchLogo("groq", { key: "", fetchImpl: impl });
    assert.equal(r.error, "not_configured");
    assert.equal(calls.length, 0);
  });

  test("the cache is bounded", async () => {
    // 500 is the cap in the module. Filling and then adding one more must evict,
    // not grow without limit.
    const { impl } = stubFetch();
    for (let i = 0; i < 505; i++) {
      await fetchLogo(`brand${i}.com`, { key: KEY, fetchImpl: impl });
    }
    assert.ok(cacheSize() <= 500, `cache grew to ${cacheSize()}`);
  });
});
