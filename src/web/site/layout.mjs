// The shared shell for the public site.
//
// Every page is generated from one layout function so a header, a footer or a
// canonical tag cannot drift between pages. The pages are written to disk as real
// .html files rather than rendered per request: a marketing page does not need a
// process, and a static file is faster, cacheable and visible in View Source.
//
// Run: node tools/site.mjs

/** The product mark, inlined so a page needs no image request for its own logo. */
export const MARK = `<svg viewBox="0 0 128 128" width="22" height="22" aria-hidden="true" focusable="false">
  <path d="M44 78V56a20 20 0 0 1 40 0v22" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/>
  <rect x="18" y="72" width="92" height="34" rx="10" fill="currentColor"/>
  <circle cx="40" cy="89" r="6" fill="var(--paper)"/><circle cx="88" cy="89" r="6" fill="var(--paper)"/>
</svg>`;

/**
 * The site's navigation. `href` is a clean path; the server maps it to a file.
 * Every page shows the same links, and the current one is marked.
 */
export const NAV = [
  ["/product", "Product"],
  ["/security", "Security"],
  ["/pricing", "Pricing"],
  ["/about", "About"],
  ["/docs", "Docs"],
];

export const FOOTER = [
  {
    title: "Product",
    links: [
      ["/product", "Overview"],
      ["/security", "Security"],
      ["/pricing", "Pricing"],
      ["/docs", "Documentation"],
    ],
  },
  {
    title: "Company",
    links: [
      ["/about", "About"],
      ["/contact", "Contact"],
    ],
  },
  {
    title: "Legal",
    links: [
      ["/privacy", "Privacy"],
      ["/terms", "Terms"],
      ["/cookies", "Cookies"],
    ],
  },
];

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * One page.
 *
 * @param {object} o
 * @param {string} o.path      the route, e.g. "/product". Used for canonical and nav state.
 * @param {string} o.title     the <title>. Must be unique per page.
 * @param {string} o.description  the meta description. Must be unique per page.
 * @param {string} o.body      the page's markup between header and footer.
 * @param {string} [o.bodyClass]
 */
export function page({ path, title, description, body, bodyClass = "" }) {
  const nav = NAV.map(
    ([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ""}>${label}</a>`
  ).join("");

  const footer = FOOTER.map(
    (col) => `<div class="col"><strong>${esc(col.title)}</strong>${col.links
      .map(([href, label]) => `<a href="${href}">${esc(label)}</a>`)
      .join("")}</div>`
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://hasp.dev${path === "/" ? "" : path}">
<meta name="theme-color" content="#f6f5f1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="https://raw.githubusercontent.com/sarang-cmd/hasp/main/docs/screens/social.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta property="og:url" content="https://hasp.dev${path === "/" ? "" : path}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/site-pages/site.css">
<link rel="preload" href="/fonts/instrument-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="/">${MARK}<span>hasp</span></a>
    <nav class="site-nav" aria-label="Main">${nav}</nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-foot">
  <div class="wrap">
    ${footer}
    <div class="col spacer"><strong>Contact</strong><a href="mailto:hello@hasp.dev">hello@hasp.dev</a></div>
  </div>
</footer>
</body>
</html>
`;
}

/** A footer note that says what the product is not, when a page needs one. */
export const SAMPLE_NOTE = `<p class="note"><strong>Sample build.</strong> Every item in the
demonstration is invented. The sample master password is printed on the unlock
screen on purpose. Do not put a real secret into this build.</p>`;
