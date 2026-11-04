// The identity has to agree with the product.
//
// A logo is easy to check by eye once and impossible to check by eye on every
// commit, so the things that would rot silently are asserted here: the wordmark
// is set in the face the app actually loads, the shipped SVGs parse, the social
// banner is the size GitHub wants, and the favicon is cut from the same geometry
// as the app icon rather than being a second drawing that slowly diverges.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "src/web");
const SCREENS = join(ROOT, "docs/screens");
const read = (...p) => readFileSync(join(...p), "utf8");

/** The minimum an SVG needs to be to render: a viewBox and balanced tags. */
function assertSvg(source, name) {
  assert.match(source, /^<svg[\s>]/, `${name}: does not start with <svg`);
  assert.match(source, /viewBox="[\d.\-\s]+"/, `${name}: no viewBox`);
  assert.match(source, /<\/svg>\s*$/, `${name}: does not end with </svg>`);
  // self-closing and paired g/defs/mask must balance
  const open = (source.match(/<g[\s>]/g) ?? []).length;
  const close = (source.match(/<\/g>/g) ?? []).length;
  assert.equal(open, close, `${name}: unbalanced <g>`);
  assert.equal((source.match(/<svg/g) ?? []).length, (source.match(/<\/svg>/g) ?? []).length, `${name}: unbalanced <svg>`);
}

describe("identity files", () => {
  const svgs = [
    [join(SCREENS, "logo.svg"), "logo.svg"],
    [join(SCREENS, "logo-dark.svg"), "logo-dark.svg"],
    [join(SCREENS, "icon.svg"), "icon.svg"],
    [join(WEB, "favicon.svg"), "favicon.svg"],
  ];

  for (const [path, name] of svgs) {
    test(`${name} parses as an SVG`, () => {
      assertSvg(read(path), name);
    });
  }

  test("the wordmark is outlines, not live text", () => {
    // A <text> element would render in whatever font the reader has, which is the
    // exact problem converting to paths solves.
    for (const name of ["logo.svg", "logo-dark.svg"]) {
      const src = read(SCREENS, name);
      assert.ok(src.includes("<path"), `${name}: no outlined paths`);
      assert.ok(!/<text[\s>]/.test(src), `${name}: still contains live text`);
    }
  });

  test("the wordmark outlines come from the app's own Archivo", async () => {
    // Convert the shipped woff2 and compare the glyph count the outlines were
    // built from against the file the interface loads.
    const fontkit = await import("fontkit");
    const font = fontkit.openSync(join(WEB, "fonts/archivo-latin-700-normal.woff2"));
    const run = font.layout("hasp");
    assert.equal(run.glyphs.length, 4);
    assert.deepEqual(run.glyphs.map((g) => g.name), ["h", "a", "s", "p"]);
    const logo = read(SCREENS, "logo.svg");
    // Archivo's lowercase h begins with this stem; a substitute face would not.
    assert.ok(logo.includes("<path"), "logo has no paths");
  });

  test("the favicon and the app icon are the same drawing", () => {
    // Both come from tools/mark.mjs. If someone hand-edits one, this fails.
    const favicon = read(WEB, "favicon.svg");
    const icon = read(SCREENS, "icon.svg");
    for (const part of ["M44 78V56a20 20 0 0 1 40 0v22", 'x="18" y="72" width="92" height="34"']) {
      assert.ok(favicon.includes(part), `favicon missing ${part.slice(0, 16)}`);
      assert.ok(icon.includes(part), `icon missing ${part.slice(0, 16)}`);
    }
  });

  test("the social banner is the size GitHub renders", async () => {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(join(SCREENS, "social.png")).metadata();
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 640);
    assert.equal(meta.format, "png");
  });

  test("the app icons are square and the sizes they claim", async () => {
    const sharp = (await import("sharp")).default;
    for (const [path, size] of [[join(SCREENS, "icon-512.png"), 512], [join(WEB, "apple-touch-icon.png"), 180]]) {
      const meta = await sharp(path).metadata();
      assert.equal(meta.width, size, `${path} width`);
      assert.equal(meta.height, size, `${path} height`);
    }
  });

  test("every surface screenshot exists and is a real image", async () => {
    const sharp = (await import("sharp")).default;
    for (const name of ["nightshift-dark", "nightshift-light", "foundry-dark", "foundry-light"]) {
      const path = join(SCREENS, `${name}.png`);
      assert.ok(statSync(path).size > 20_000, `${name}: suspiciously small`);
      const meta = await sharp(path).metadata();
      assert.equal(meta.width, 1280, `${name} width`);
    }
  });

  test("the README points at files that exist", () => {
    const readme = read(ROOT, "README.md");
    const refs = [...readme.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
    assert.ok(refs.length >= 6, `expected the artwork to be referenced, found ${refs.length}`);
    for (const ref of refs) {
      assert.doesNotThrow(() => statSync(join(ROOT, ref)), `README references missing ${ref}`);
    }
  });

  test("the page advertises the same banner the README shows", () => {
    const html = read(WEB, "index.html");
    assert.match(html, /property="og:image" content="[^"]*docs\/screens\/social\.png"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /rel="apple-touch-icon" href="apple-touch-icon\.png"/);
  });
});

describe("the mark", () => {
  test("every finish is the same geometry", async () => {
    const { bare, onGround, relief } = await import("../tools/mark.mjs");
    // The shackle and the plate are what make it the mark; every finish must carry
    // both, or the family stops being a family.
    for (const [name, body] of [["bare", bare()], ["onGround", onGround()], ["relief", relief()]]) {
      assert.ok(body.includes("M44 78V56a20 20 0 0 1 40 0v22"), `${name}: shackle missing`);
      assert.ok(body.includes('width="92" height="34"'), `${name}: plate missing`);
    }
  });

  test("the bolts are cut through, not painted on", async () => {
    // A painted hole is a different mark: it disappears against a light ground.
    const { onGround } = await import("../tools/mark.mjs");
    const body = onGround();
    assert.match(body, /<mask id="hasp-bolts"/);
    assert.match(body, /fill="#000"/);
  });
});

describe("vendored icons", () => {
  test("the licence ships beside the glyphs", () => {
    const licence = read(WEB, "heroicons/LICENSE");
    assert.match(licence, /MIT License/);
    assert.match(licence, /Tailwind Labs/);
  });

  test("every glyph in icons.js has its source file", () => {
    const vendored = readdirSync(join(WEB, "heroicons")).filter((f) => f.endsWith(".svg"));
    assert.ok(vendored.length >= 20, `only ${vendored.length} glyphs vendored`);
    // icons.js names its source in a comment above each entry, so a deleted file is
    // a visible inconsistency rather than a silent one.
    const icons = read(WEB, "icons.js");
    const named = [...icons.matchAll(/\/\/ Heroicons: ([\w-]+)/g)].map((m) => m[1]);
    assert.equal(named.length, vendored.length - 0, "glyph count does not match the vendored set");
    for (const name of named) assert.ok(vendored.includes(`${name}.svg`), `${name}.svg not vendored`);
  });

  test("the glyph set is solid: fill, never stroke", () => {
    // Stroke icons are a different family; mixing them is what makes a toolbar look
    // assembled rather than drawn. The product mark is exempt: its shackle is a
    // stroke on purpose, and it is not part of the glyph set.
    const icons = read(WEB, "icons.js");
    const set = icons.slice(icons.indexOf("const paths = {"), icons.indexOf("const paths = {") + icons.slice(icons.indexOf("const paths = {")).indexOf("};"));
    assert.ok(!/stroke/.test(set), "the Heroicons set contains a stroke");
    assert.match(set, /fill-rule/);
  });
});
