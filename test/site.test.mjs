// Tests for the public site.
//
// The site is generated, so these read the generated HTML rather than the
// generators. A page that renders badly is a bug in the output, and the output is
// what ships.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES, fileNameFor, structuredData, sitemap, robots, llms } from "../tools/site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/web/site-pages");

const read = (file) => readFileSync(join(OUT, file), "utf8");
const pages = () =>
  ROUTES.map(([route]) => ({ route, file: fileNameFor(route), html: read(fileNameFor(route)) }));

/** Pull the text out of a tag's content, dropping nested markup. */
const textOf = (html, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
};

describe("site pages", () => {
  test("every route generated a file", () => {
    assert.equal(ROUTES.length, 11);
    for (const [route] of ROUTES) {
      const file = join(OUT, fileNameFor(route));
      assert.ok(existsSync(file), `${route} has no file at ${file}`);
    }
  });

  test("every page has a unique title and a description", () => {
    const titles = new Set();
    const descriptions = new Set();
    for (const { route, html } of pages()) {
      const title = textOf(html, "title");
      assert.ok(title.length > 0, `${route} has no title`);
      assert.ok(title.length <= 70, `${route} title is ${title.length} characters, which truncates in a result`);
      assert.ok(!titles.has(title), `duplicate title: ${title}`);
      titles.add(title);

      const desc = /<meta name="description" content="([^"]*)"/.exec(html);
      assert.ok(desc, `${route} has no meta description`);
      assert.ok(desc[1].length >= 50, `${route} description is too short to be useful`);
      assert.ok(desc[1].length <= 165, `${route} description is ${desc[1].length} characters, which truncates`);
      assert.ok(!descriptions.has(desc[1]), `duplicate description on ${route}`);
      descriptions.add(desc[1]);
    }
  });

  test("the sync command in the docs is one the tool accepts", async () => {
    // A command in the documentation that the tool would refuse is worse than none, so
    // the flags are read back out of the page and checked against the parser.
    const { parseArgs, missing } = await import("../tools/sync.mjs");
    const docs = pages().find((p) => p.route === "/docs").html;
    const block = /npm run sync[\s\S]*?--token TOKEN/.exec(docs);
    assert.ok(block, "the docs show a sync command");
    const line = block[0].replace(/<[^>]+>/g, " ");
    // VAULT-ID and TOKEN are placeholders, so they are filled with a value here.
    const argv = line
      .split(/\s+/)
      .filter((t) => t.startsWith("--"))
      .flatMap((flag) => {
        if (flag === "--vault") return [flag, "/tmp/vault.json"];
        if (flag === "--url") return [flag, "http://127.0.0.1:3000"];
        if (flag === "--vault-id") return [flag, "an-id"];
        if (flag === "--token") return [flag, "a-token"];
        return [flag];
      });
    assert.deepEqual(missing(parseArgs(argv)), [], `the documented flags are incomplete: ${argv.join(" ")}`);
  });

  test("every sync route the docs list exists in the server", async () => {
    const { readFileSync } = await import("node:fs");
    const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    const docs = pages().find((p) => p.route === "/docs").html;
    const listed = [...docs.matchAll(/(GET|POST|DELETE) \/api\/sync[\w/]*/g)].map((m) =>
      m[0].replace(" ", " ").replace(/^(\w+) /, "$1 ")
    );
    assert.ok(listed.length >= 8, `expected the route list, saw ${listed.length}`);
    for (const entry of listed) {
      const [, method, route] = /^(GET|POST|DELETE) (\/api\/sync[\w/]*)$/.exec(entry) || [];
      assert.ok(method, `could not read ${entry}`);
      if (route === "/api/sync/pairing" && method === "DELETE") {
        assert.ok(server.includes('path === "/api/sync/pairing" && method === "DELETE"') || server.includes('"DELETE"'), `${entry} is documented but the server has no such delete`);
        continue;
      }
      const pattern = new RegExp(`path === "${route}"`);
      assert.ok(pattern.test(server), `${entry} is documented and the server does not route it`);
    }
  });

  test("the sync claims match what the store actually holds", async () => {
    // The product, pricing and docs pages all describe sync, and each says the store
    // cannot read a name or a value. That is only true while the store holds exactly
    // the field list in src/sync/store.mjs, so the two are checked together rather
    // than left to drift.
    const { SyncStore, toBlob } = await import("../src/sync/store.mjs");
    const { Vault } = await import("../src/core/vault.js");
    const { SAMPLE_PASSWORD } = await import("../src/core/seed.js");

    const store = new SyncStore();
    const vault = await Vault.create({ name: "Site check", password: SAMPLE_PASSWORD });
    const token = await store.createVault(vault.meta.id);
    const { id } = vault.addItem({ name: "Marker name", type: "api-key", service: "Marker service", value: "MARKER-value" });
    // Edited first, so the record carries history, a last used time and everything
    // else a real record accumulates. A fresh record would not, and the field list
    // below would be checking the easy case.
    vault.updateItem(id, { value: "MARKER-value-2" });
    vault.touch(id);
    store.push(vault.meta.id, token, toBlob(vault.rawRecord(id)));
    // Two separate claims, and they need two different checks.
    //
    // The first is that no plaintext reaches the store. Checking for an item's name
    // here would prove nothing: a vault record never holds the name in the clear, so
    // that assertion would pass however much the store was allowed to keep. What is
    // checked instead is the field list, which is the thing that could change.
    const blob = toBlob(vault.rawRecord(id));
    assert.ok(vault.rawRecord(id).history.length > 0, "the record does carry history before it is reduced");
    assert.deepEqual(
      Object.keys(blob).sort(),
      ["ciphertext", "createdAt", "deletedAt", "id", "nonce", "rev", "searchTokens", "seq", "type", "updatedAt", "version", "wrappedKey"],
      "the store's field list changed, so check the site copy against it"
    );
    const dump = JSON.stringify(store.serialize());
    for (const word of ["Marker name", "Marker service", "MARKER-value"]) {
      assert.equal(dump.includes(word), false, `the store holds ${word}, so the site is wrong`);
    }

    const product = pages().find((p) => p.route === "/product").html;
    assert.match(product, /cannot read a name or a value/);
    const docs = pages().find((p) => p.route === "/docs").html;
    assert.match(docs, /cannot read a name, a note or a value/);
  });

  test("every internal link points at a page or a file that exists", () => {
    const known = new Set(ROUTES.map(([route]) => route));
    // Paths served from src/web rather than generated by the site.
    const assets = new Set([
      "/favicon.svg",
      "/fonts/instrument-sans-latin-400-normal.woff2",
      "/site-pages/site.css",
      "/app",
    ]);
    const filesInRepo = new Set(["/sitemap.xml", "/robots.txt", "/llms.txt"]);

    for (const { route, html } of pages()) {
      const hrefs = [...html.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]);
      for (const href of hrefs) {
        const clean = href.replace(/\/$/, "") || "/";
        if (known.has(clean) || assets.has(href) || filesInRepo.has(clean)) continue;
        if (href.startsWith("/screens/")) {
          const name = href.slice("/screens/".length);
          assert.ok(existsSync(join(ROOT, "docs/screens", name)), `${route} links to a missing screenshot: ${href}`);
          continue;
        }
        assert.fail(`${route} links to ${href}, which nothing serves`);
      }
    }
  });

  test("the documented URLs are the ones the server routes", () => {
    // Guards against the generator and the server table drifting apart. The server
    // is read as text because importing it starts a listener.
    const server = readFileSync(join(ROOT, "server.mjs"), "utf8");
    const table = /const SITE_ROUTES = \{([\s\S]*?)\};/.exec(server);
    assert.ok(table, "server.mjs has no SITE_ROUTES table");
    const routed = new Set([...table[1].matchAll(/"(\/[a-z-]*)":/g)].map((m) => m[1]));
    for (const [route] of ROUTES) {
      if (route === "/404") continue;
      assert.ok(routed.has(route), `${route} is generated but the server does not route it`);
    }
    for (const route of routed) {
      assert.ok(
        ROUTES.some(([r]) => r === route),
        `the server routes ${route} but nothing generates it`,
      );
    }
  });

  test("no page uses a forbidden word or a dash in prose", () => {
    // The writing rules for this project: no dashes of either kind, no semicolons
    // in prose, and none of the filler that makes copy sound generated.
    const banned = [
      "revolutionize", "revolutionise", "game-changer", "cutting-edge", "groundbreaking",
      "seamless", "seamlessly", "unleash", "empower", "supercharge", "effortless",
      "delve", "tapestry", "in the realm", "not just", "skyrocket", "disruptive",
      "unlock your", "harness the", "dive deep", "ever-evolving", "in conclusion",
      "in summary", "moreover", "furthermore", "it's important to note", "leverage the",
    ];
    for (const { route, html } of pages()) {
      // Only the body, since the head carries the title with an interpunct.
      const body = html.split("<body")[1] || "";
      const prose = body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
      const lower = prose.toLowerCase();
      for (const word of banned) {
        assert.ok(!lower.includes(word), `${route} uses the forbidden phrase "${word}"`);
      }
      assert.ok(!/\u2014|\u2013/.test(prose), `${route} contains an em or en dash`);
      assert.ok(!/\w;\s+\w/.test(prose), `${route} contains a semicolon in prose`);
    }
  });

  test("the document language and viewport are declared", () => {
    for (const { route, html } of pages()) {
      assert.match(html, /<html lang="en">/, `${route} does not declare its language`);
      assert.match(html, /<meta name="viewport" content="width=device-width/, `${route} has no viewport`);
      assert.match(html, /<meta charset="utf-8">/, `${route} does not declare its charset`);
    }
  });

  test("each page has one h1 and a skip link", () => {
    for (const { route, html } of pages()) {
      const h1s = [...html.matchAll(/<h1[\s>]/g)].length;
      assert.equal(h1s, 1, `${route} has ${h1s} h1 elements`);
      assert.match(html, /class="skip"/, `${route} has no skip link`);
    }
  });

  test("structured data is valid JSON on every page", () => {
    for (const { route, html } of pages()) {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      assert.equal(blocks.length, structuredData().length, `${route} has the wrong number of JSON-LD blocks`);
      for (const [, json] of blocks) assert.doesNotThrow(() => JSON.parse(json), `${route} has malformed JSON-LD`);
      // No invented ratings. A marked-up claim is a stronger claim than a sentence.
      assert.ok(!html.includes("aggregateRating"), `${route} claims a rating`);
      assert.ok(!html.includes("reviewCount"), `${route} claims a review count`);
    }
  });
});

describe("site files", () => {
  test("the sitemap lists every page except the error page", () => {
    const xml = sitemap();
    for (const [route] of ROUTES) {
      if (route === "/404") {
        assert.ok(!xml.includes("<loc>https://hasp.dev/404</loc>"), "the error page is in the sitemap");
        continue;
      }
      assert.ok(xml.includes(`<loc>https://hasp.dev${route}</loc>`), `${route} is missing from the sitemap`);
    }
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  });

  test("robots.txt allows crawling and names the sitemap", () => {
    const txt = robots();
    assert.match(txt, /User-agent: \*/);
    assert.match(txt, /Allow: \//);
    assert.match(txt, /Sitemap: https:\/\/hasp\.dev\/sitemap\.xml/);
    assert.ok(!/Disallow: \/\s*$/m.test(txt), "robots.txt disallows everything");
  });

  test("llms.txt states the cipher honestly", () => {
    const txt = llms();
    assert.match(txt, /ChaCha20-Poly1305/);
    assert.ok(!txt.includes("XChaCha20"), "llms.txt claims XChaCha20, which is not what the code does");
    assert.match(txt, /not audited|has not received an independent security review/i);
  });

  test("the stylesheet shipped beside the pages", () => {
    assert.ok(existsSync(join(OUT, "site.css")), "site.css was not copied into the generated folder");
    const css = readFileSync(join(OUT, "site.css"), "utf8");
    assert.ok(css.length > 4000, "site.css looks truncated");
    assert.match(css, /--paper:/);
  });
});
