// Generates the public site, its sitemap, its robots file and its structured data.
//
// The pages are written to src/web/site-pages/ as real HTML files. They are static
// because a marketing page does not need a process: a file is cacheable, fast, and
// shows complete markup in View Source, which a client-rendered page does not.
//
// Run: npm run site

import { writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as pages from "../src/web/site/pages.mjs";
import * as legal from "../src/web/site/legal.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "src/web/site-pages");

/**
 * Route table. The first entry of each pair is the URL path, the second is the
 * generator. This list is also what the sitemap and the route tests read, so a page
 * cannot exist without appearing in both.
 */
export const ROUTES = [
  ["/", pages.home],
  ["/product", pages.product],
  ["/security", pages.security],
  ["/pricing", pages.pricing],
  ["/about", pages.about],
  ["/docs", pages.docs],
  ["/contact", pages.contact],
  ["/privacy", legal.privacy],
  ["/terms", legal.terms],
  ["/cookies", legal.cookies],
  ["/404", legal.notFound],
];

/** "/product" -> "product.html", "/" -> "index.html". */
export function fileNameFor(route) {
  if (route === "/") return "index.html";
  return `${route.replace(/^\//, "").replace(/\//g, "-")}.html`;
}

/**
 * Organization and SoftwareApplication structured data.
 *
 * Only facts in the software are asserted. No aggregateRating, no review count, no
 * address, no founding date: those would be invented claims in a machine-readable
 * format, which is worse than an invented claim on a page.
 */
export function structuredData() {
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Hasp",
      applicationCategory: "SecurityApplication",
      operatingSystem: "Linux, macOS, Windows",
      description:
        "A local-first vault for API keys, backup codes and one-time codes. Runs on your machine with no account and no network access at runtime.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Hasp",
      url: "https://hasp.dev",
      email: "hello@hasp.dev",
      description: "A small local-first tool for keeping API keys and one-time codes in order.",
    },
  ];
}

/** Every route, its last-modified date, for sitemap.xml. */
export function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ROUTES.filter(([route]) => route !== "/404")
    .map(([route]) => {
      // The demonstration is not a marketing page and is excluded from the sitemap.
      const priority = route === "/" ? "1.0" : route.startsWith("/docs") ? "0.6" : "0.8";
      return `  <url>\n    <loc>https://hasp.dev${route === "/" ? "/" : route}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** robots.txt. AI crawlers are allowed, which the plan asks for explicitly. */
export function robots() {
  return `# https://hasp.dev
User-agent: *
Allow: /

# AI crawlers are welcome. The content is public and the product is MIT licensed.
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

Sitemap: https://hasp.dev/sitemap.xml
`;
}

/**
 * llms.txt: a short, plain summary for a language model to read instead of
 * guessing at the markup. The convention is a title, a summary and link sections.
 */
export function llms() {
  return `# Hasp

> A local-first vault for API keys, backup codes and one-time codes. It runs on your
> own machine as a single Node process, needs no account, and makes no network
> request at runtime. The vault is one encrypted file. Tested, not audited.

The cipher is ChaCha20-Poly1305 with a 12 byte random nonce.
Cryptography runs in the Node server, so plaintext crosses the loopback interface.
It has not received an independent security review.

## Pages

- [Home](https://hasp.dev/): what the product is and what it deliberately is not.
- [Product](https://hasp.dev/product): the vault, the two design directions, and import.
- [Security](https://hasp.dev/security): guarantees, gaps and the threat model.
- [Pricing](https://hasp.dev/pricing): free during development, no paid tier exists.
- [Docs](https://hasp.dev/docs): run it, import exports, keyboard shortcuts.
- [Privacy](https://hasp.dev/privacy): no analytics, nothing leaves the machine.
- [Terms](https://hasp.dev/terms): provided as-is, not audited.

## Optional

- [About](https://hasp.dev/about): why it exists and what it is built from.
- [Contact](https://hasp.dev/contact): one address, read by the person who builds it.
`;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const written = [];
  for (const [route, render] of ROUTES) {
    const html = render();
    const file = join(OUT, fileNameFor(route));
    writeFileSync(file, html);
    written.push([route, fileNameFor(route), html.length]);
  }

  // The structured data is injected into every page at build time rather than
  // written per page, so the two cannot disagree.
  const jsonld = structuredData()
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`)
    .join("\n");
  for (const [, file] of written) {
    const path = join(OUT, file);
    const html = readFileSync(path, "utf8").replace("</head>", `${jsonld}\n</head>`);
    writeFileSync(path, html);
  }

  // The stylesheet is copied rather than served from src/web/site/, so the generated
  // folder is self-contained and the relative path in every page resolves.
  copyFileSync(join(ROOT, "src/web/site/site.css"), join(OUT, "site.css"));

  writeFileSync(join(ROOT, "src/web/sitemap.xml"), sitemap());
  writeFileSync(join(ROOT, "src/web/robots.txt"), robots());
  writeFileSync(join(ROOT, "src/web/llms.txt"), llms());

  console.log(`site: ${written.length} pages`);
  for (const [route, file] of written) console.log(`  ${route.padEnd(12)} ${file}`);
  console.log("plus sitemap.xml, robots.txt, llms.txt");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
