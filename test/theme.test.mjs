// Guards on the two directions.
//
// Neumorphism puts controls in the surface instead of on top of it, so it is
// easy to lose the contrast floor while it still looks calm. Plan section 8 and
// section 9 ask for WCAG 2.1 AA. These tests parse the real token file, so a
// colour change that breaks the floor fails the build rather than the review.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/web/tokens.css", import.meta.url), "utf8");

/** Pull one token block: :root[data-dir="x"][data-mode="y"] { ... } */
function block(dir, mode) {
  // The block may be declared for :root and for a container in one selector
  // list, so the leading :root is optional here.
  const re = new RegExp(
    `(?:^|,)\\s*(?::root)?\\[data-dir="${dir}"\\]\\[data-mode="${mode}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`,
    "m"
  );
  const m = re.exec(CSS);
  assert.ok(m, `missing token block for ${dir} ${mode}`);
  const tokens = {};
  for (const line of m[1].split("\n")) {
    const t = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line);
    if (t) tokens[t[1]] = t[2].trim();
  }
  return tokens;
}

/** Parse #rgb, #rrggbb or rgba(r, g, b, a) into [r, g, b, a]. */
function parseColor(value) {
  const v = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(v);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`cannot parse colour: ${v}`);
}

/** Flatten a possibly translucent colour over an opaque one. */
function over(fg, bg) {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  return [Math.round(r * a + br * (1 - a)), Math.round(g * a + bgc * (1 - a)), Math.round(b * a + bb * (1 - a)), 1];
}

function luminance(rgb) {
  const [r, g, b] = rgb.slice(0, 3).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two colours, with alpha compositing. */
export function contrast(fg, bg) {
  const background = parseColor(bg);
  const foreground = parseColor(fg);
  const f = foreground[3] < 1 ? over(fg, bg) : foreground;
  const l1 = luminance(f);
  const l2 = luminance(background);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const COMBOS = [
  ["foundry", "light"],
  ["foundry", "dark"],
  ["nightshift", "light"],
  ["nightshift", "dark"],
];

const AA_TEXT = 4.5;      // normal text
const AA_LARGE = 3;       // 18.66px bold or 24px
const AA_UI = 3;          // non-text UI and graphical objects

describe("every direction and mode", () => {
  for (const [dir, mode] of COMBOS) {
    describe(`${dir} ${mode}`, () => {
      const t = block(dir, mode);

      test("declares the full token set", () => {
        for (const key of [
          "--bg", "--panel", "--panel-2", "--rail", "--ink", "--ink-2", "--mut",
          "--line", "--line-2", "--accent", "--accent-ink", "--ok", "--bad", "--header", "--header-ink",
        ]) {
          assert.ok(t[key], `${dir} ${mode} is missing ${key}`);
        }
        assert.match(t["--bg"], /^#[0-9a-f]{6}$/i);
      });

      test("body text meets AA on every surface it sits on", () => {
        for (const surface of ["--bg", "--panel", "--panel-2", "--rail"]) {
          const ratio = contrast(t["--ink"], t[surface]);
          assert.ok(ratio >= AA_TEXT, `${t["--ink"]} on ${surface} is ${ratio.toFixed(2)}:1, needs ${AA_TEXT}:1`);
        }
      });

      test("secondary text meets AA", () => {
        for (const surface of ["--bg", "--panel"]) {
          const ratio = contrast(t["--ink-2"], t[surface]);
          assert.ok(ratio >= AA_TEXT, `ink-2 on ${surface} is ${ratio.toFixed(2)}:1`);
        }
      });

      test("muted text meets AA on panels, and 3:1 on the rail", () => {
        const onPanel = contrast(t["--mut"], t["--panel"]);
        assert.ok(onPanel >= AA_TEXT, `mut on panel is ${onPanel.toFixed(2)}:1`);
        // The rail carries only short labels, but they are still text.
        const onRail = contrast(t["--mut"], t["--rail"]);
        assert.ok(onRail >= AA_TEXT, `mut on rail is ${onRail.toFixed(2)}:1`);
      });

      test("the accent is legible as a label and as a fill", () => {
        const asText = contrast(t["--accent"], t["--panel"]);
        assert.ok(asText >= AA_LARGE, `accent as text is ${asText.toFixed(2)}:1, needs ${AA_LARGE}:1`);
        const asFill = contrast(t["--accent-ink"], t["--accent"]);
        assert.ok(asFill >= AA_TEXT, `text on an accent fill is ${asFill.toFixed(2)}:1`);
      });

      test("the solid ink bands are readable", () => {
        const ratio = contrast(t["--header-ink"], t["--header"]);
        assert.ok(ratio >= AA_TEXT, `header pair is ${ratio.toFixed(2)}:1`);
      });

      test("status colours are distinguishable from the surface", () => {
        for (const key of ["--ok", "--bad", "--warn"]) {
          const ratio = contrast(t[key], t["--panel"]);
          assert.ok(ratio >= AA_UI, `${key} on panel is ${ratio.toFixed(2)}:1, needs ${AA_UI}:1`);
        }
      });

      test("rules are visible without being loud", () => {
        const ratio = contrast(t["--line"], t["--panel"]);
        assert.ok(ratio >= 1.15, `line on panel is ${ratio.toFixed(2)}:1, invisible`);
        assert.ok(ratio <= AA_TEXT, `line on panel is ${ratio.toFixed(2)}:1, too loud for a rule`);
      });

      test("the focus ring is visible against both grounds", () => {
        const onBg = contrast(t["--focus"], t["--bg"]);
        assert.ok(onBg >= AA_UI, `focus on bg is ${onBg.toFixed(2)}:1`);
      });
    });
  }
});

describe("direction identity", () => {
  test("Foundry is square and Nightshift is soft", () => {
    const foundry = /[,\n]\s*(?::root)?\[data-dir="foundry"\]\s*\{([\s\S]*?)\n\}/.exec(CSS);
    const night = /[,\n]\s*(?::root)?\[data-dir="nightshift"\]\s*\{([\s\S]*?)\n\}/.exec(CSS);
    assert.ok(foundry && night);
    assert.match(foundry[1], /--r:\s*0px/);
    assert.match(foundry[1], /--r-sm:\s*0px/);
    assert.match(night[1], /--r:\s*12px/);
    assert.match(night[1], /--r-sm:\s*9px/);
  });

  test("Nightshift defines paired light and dark shadows in both modes", () => {
    for (const mode of ["light", "dark"]) {
      const t = block("nightshift", mode);
      for (const key of ["--lift", "--press", "--hl", "--sh"]) {
        assert.ok(t[key], `nightshift ${mode} is missing ${key}`);
        // The lift must use both, or it stops reading as neumorphic.
        if (key === "--lift") {
          assert.match(t[key], /var\(--sh\)/);
          assert.match(t[key], /var\(--hl\)/);
        }
        if (key === "--press") {
          assert.match(t[key], /inset/);
        }
      }
    }
  });

  test("Foundry has no neumorphic shadow and Nightshift has no hard rule", () => {
    for (const mode of ["light", "dark"]) {
      const t = block("foundry", mode);
      assert.equal(t["--lift"], "none");
      assert.equal(t["--press"], "none");
    }
  });

  test("each mode is declared for both directions", () => {
    for (const dir of ["foundry", "nightshift"]) {
      for (const mode of ["light", "dark"]) {
        assert.ok(block(dir, mode), `${dir} ${mode} missing`);
      }
    }
  });
});

describe("contrast helper", () => {
  test("matches the WCAG worked examples", () => {
    assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
    assert.equal(contrast("#ffffff", "#ffffff").toFixed(2), "1.00");
    assert.ok(Math.abs(contrast("#777777", "#ffffff") - 4.48) < 0.05);
  });

  test("composites alpha before measuring", () => {
    assert.ok(contrast("rgba(0, 0, 0, 0.5)", "#ffffff") < contrast("#000000", "#ffffff"));
    assert.equal(contrast("rgba(0, 0, 0, 0)", "#ffffff").toFixed(2), "1.00");
  });
});

// ---------------------------------------------------------------------------
// Layout cascade.
//
// A specificity fight in CSS is invisible to every other test in this suite: the
// markup is correct, the tokens are correct, and the element still renders wrong.
// The live app squashed every company wordmark into a 17px square because
// `:root[data-dir] .tile img` outranked `.tile--wordmark img`, while the generated
// screenshots looked right because the renderer never applies the stylesheet.
//
// These check the specific collision that caused it, and that any future rule
// targeting `.tile img` under a direction selector excludes the sized variants.

const APP_CSS = readFileSync(new URL("../src/web/app.css", import.meta.url), "utf8");

/** The declaration blocks whose selector matches a predicate. */
function rules(predicate) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(APP_CSS))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selector && !selector.startsWith("@") && predicate(selector)) out.push({ selector, body: m[2] });
  }
  return out;
}

describe("tile sizing cascade", () => {
  test("a direction rule targeting tile images excludes the sized variants", () => {
    // Any selector that sets an img width inside a tile, scoped to a direction,
    // must not also match .tile--wide or .tile--wordmark: those exist to give a
    // wordmark the width it needs.
    // Note the shape of this predicate: the width check belongs on the rule body,
    // not the selector. An earlier version had `&& /width:/.test("")` inside the
    // selector predicate, which is always false, so the test passed while the bug
    // was still present. Checked by reverting the fix and watching it fail.
    const risky = rules((sel) => sel.includes("[data-dir=") && sel.includes(".tile") && sel.includes("img")).filter(
      (r) => /(?:^|;|\s)width\s*:/.test(r.body)
    );

    for (const rule of risky) {
      assert.ok(
        rule.selector.includes(":not(.tile--wide)") || rule.selector.includes(":not(.tile--wordmark)"),
        `"${rule.selector}" sets an image width inside a direction scope without excluding the wide variants. ` +
          `It will override .tile--wide/.tile--wordmark, which have lower specificity.`
      );
    }
  });

  test("wordmarks are wider than plain tiles", () => {
    const plain = rules((s) => s.trim() === ".tile").map((r) => /width:\s*([\d.]+)px/.exec(r.body)?.[1]).find(Boolean);
    const word = rules((s) => s.trim() === ".tile--wordmark").map((r) => /width:\s*([\d.]+)px/.exec(r.body)?.[1]).find(Boolean);
    assert.ok(plain, "no base .tile width");
    assert.ok(word, "no .tile--wordmark width");
    assert.ok(Number(word) > Number(plain), `wordmark slot (${word}px) must be wider than a tile (${plain}px)`);
  });

  test("the wordmark image keeps an aspect ratio near 3:1", () => {
    // The vendored wordmarks are on a 512-wide grid at roughly 66 to 323 tall. A
    // box far from that shape re-squashes them, which is the bug this guards.
    const rule = rules((s) => s.trim() === ".tile--wordmark img")[0];
    assert.ok(rule, "no .tile--wordmark img rule");
    const w = Number(/width:\s*([\d.]+)px/.exec(rule.body)?.[1]);
    const h = Number(/height:\s*([\d.]+)px/.exec(rule.body)?.[1]);
    assert.ok(w / h >= 2.5 && w / h <= 3.5, `wordmark image is ${w}x${h}, ratio ${(w / h).toFixed(2)}`);
  });

  test("a long brand name cannot push the row apart", () => {
    // The row is a flex container; without min-width:0 on the text column a long
    // name prevents ellipsis and forces the row wider than the list.
    assert.match(APP_CSS, /\.row-main\s*\{[^}]*min-width:\s*0/, ".row-main needs min-width: 0");
    assert.match(APP_CSS, /\.row-name\s*\{[^}]*text-overflow:\s*ellipsis/, ".row-name needs ellipsis");
  });
});

// ---------------------------------------------------------------------------
// Accent styles.
//
// The accent is a separate axis from direction and mode: colour keeps the
// direction's own hue, mono is ink on ink, grey is neutral. Each is measured, so a
// style cannot be added by picking a pleasant hex and hoping.

/** Read a token block for an accent style and mode. */
function accentBlock(mode, accent) {
  const re = new RegExp(`\\[data-mode="${mode}"\\]\\[data-accent="${accent}"\\]\\s*\\{([\\s\\S]*?)\\}`, "m");
  const m = re.exec(CSS);
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
}

describe("accent styles", () => {
  test("every style is declared for both modes", () => {
    for (const accent of ["mono", "grey"]) {
      for (const mode of ["light", "dark"]) {
        assert.ok(accentBlock(mode, accent), `${accent} ${mode} missing`);
      }
    }
  });

  test("accent ink clears AA on the accent fill", () => {
    // The accent is used as a solid button background with --accent-ink on top, so
    // this is body text at body size: 4.5:1, not 3:1.
    for (const accent of ["mono", "grey"]) {
      for (const mode of ["light", "dark"]) {
        const b = accentBlock(mode, accent);
        const ratio = contrast(b["--accent"], b["--accent-ink"]);
        assert.ok(ratio >= 4.5, `${accent} ${mode}: ${ratio.toFixed(2)}:1 is under 4.5`);
      }
    }
  });

  test("mono is actually mono", () => {
    // Black on white in light, white on black in dark. If these drift into a tint
    // the style stops being the colourless option it exists to provide.
    assert.equal(accentBlock("light", "mono")["--accent"], "#16181c");
    assert.equal(accentBlock("dark", "mono")["--accent"], "#f2f4f7");
  });

  test("the default accent is still the direction's own", () => {
    // No data-accent attribute means colour: the direction block supplies it.
    const light = block("nightshift", "light");
    assert.ok(light["--accent"], "nightshift light lost its accent");
    assert.notEqual(light["--accent"], "#16181c", "the default must not be the mono style");
  });
});
