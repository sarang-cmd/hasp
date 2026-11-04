// Renders the interface to PNG without a browser.
//
// This is not a mock-up drawn by hand: the colours, radii and shadows are read
// out of src/web/tokens.css, and the fonts are the woff2 files the app serves.
// What it cannot do is run app.js, so the layout below mirrors the markup in
// src/web/app.js rather than executing it. `tools/shoot.mjs` remains the way to
// capture a real browser; this is the version that works in CI and in a sandbox
// with no Chromium.
//
// Run: node tools/render.mjs

import sharp from "sharp";
import { decompress } from "wawoff2";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { icon } from "../src/web/icons.js";
import { onGround, relief } from "./mark.mjs";
import { wordmark, outline } from "./wordmark.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/screens");
const FONTDIR = "/tmp/hasp-fonts";

// ---------------------------------------------------------------------------
// Tokens, read from the stylesheet the product actually ships.

const CSS = readFileSync(join(ROOT, "src/web/tokens.css"), "utf8");

/**
 * Pull a block's custom properties out of tokens.css.
 *
 * A block is declared once for :root and once for a bare container, so the
 * selector list is several lines and ends in a comma. Scan for the block whose
 * selector text contains the hint rather than trying to regex the whole list.
 */
function block(selectorHint) {
  const blocks = [];
  let i = 0;
  while (i < CSS.length) {
    const open = CSS.indexOf("{", i);
    if (open === -1) break;
    const close = CSS.indexOf("}", open);
    if (close === -1) break;
    const selector = CSS.slice(i, open);
    // Skip the leading comments so they never match a selector.
    const clean = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (clean && !clean.startsWith("@")) blocks.push([clean, CSS.slice(open + 1, close)]);
    i = close + 1;
  }
  // Compare against each comma-separated selector segment, ignoring :root. A bare
  // `includes` would match [data-dir="nightshift"][data-mode="dark"] when asked for
  // [data-dir="nightshift"], which silently drops --r.
  const seg = (x) => x.replace(/:root/g, "").trim();
  const hit = blocks.find(([sel]) => sel.split(",").some((part) => seg(part) === selectorHint));
  if (!hit) throw new Error(`no block for ${selectorHint}`);
  return Object.fromEntries([...hit[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
}

const BASE = {};
function tokens(dir, mode) {
  const t = {
    ...BASE,
    ...block(`[data-dir="${dir}"][data-mode="${mode}"]`),
    ...block(`[data-dir="${dir}"]`),
  };
  // Nightshift's direction block re-states the lift offsets.
  if (dir === "nightshift") Object.assign(t, block('[data-dir="nightshift"]'));
  return t;
}

/** A CSS shadow string to an SVG filter. Returns attrs for a g element. */
let uid = 0;
function shadow(t, kind) {
  const id = `s${uid++}`;
  if (dir(t) !== "nightshift") return { defs: "", attr: "" };
  // Nightshift light and dark share one geometry, so the offsets are constants.
  // They are read from the tokens rather than typed here for that reason.
  const x = parseFloat(t["--lift-x"] ?? "5");
  const y = parseFloat(t["--lift-y"] ?? "5");
  const b = parseFloat(t["--lift-blur"] ?? "12");
  const sh = t["--sh"];
  const hl = t["--hl"];
  const raised = kind === "lift";
  const defs = raised
    ? `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="${x}" dy="${y}" stdDeviation="${b / 2}" flood-color="${sh}"/><feDropShadow dx="${-x}" dy="${-y}" stdDeviation="${(b - 3) / 2}" flood-color="${hl}"/></filter>`
    : `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="2.5" result="b"/><feOffset dx="2.5" dy="2.5" in="b" result="o"/><feComposite in="SourceGraphic" in2="o" operator="out" result="c"/><feFlood flood-color="${sh}" result="f"/><feComposite in="f" in2="c" operator="in" result="s"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="s"/></feMerge></filter>`;
  return { defs, attr: ` filter="url(#${id})"`, id };
}
function dir(t) {
  return t["--r"] === "0px" ? "foundry" : "nightshift";
}

// ---------------------------------------------------------------------------
// Small drawing helpers. Every one takes tokens, so a surface is drawn once and
// rendered in whichever direction and mode is asked for.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const text = (x, y, s, { size = 13, fill, weight = 400, family = "Instrument Sans", anchor = "start", mono = false, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="${mono ? "IBM Plex Mono" : family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}">${esc(s)}</text>`;

/** A rectangle, optionally raised or pressed, with the direction's radius. */
function rect(x, y, w, h, t, { fill = t["--panel"], kind = "flat", r, stroke, extra = "" } = {}) {
  const radius = r ?? parseFloat(t["--r"]);
  const sh = kind === "flat" ? { defs: "", attr: "" } : shadow(t, kind);
  const s = stroke ? ` stroke="${stroke}" stroke-width="1"` : "";
  return {
    defs: sh.defs,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"${s}${sh.attr}${extra ? " " + extra : ""}/>`,
  };
}

/** A line of type, sized and coloured for the role. */
const label = (t, x, y, s, { size = 13, role = "ink", ...rest } = {}) =>
  text(x, y, s, { size, fill: t[role === "ink" ? "--ink" : role === "mut" ? "--mut" : role], ...rest });

/** A solid Heroicons glyph, scaled from its 24px grid. */
function glyph(name, x, y, size, fill, opacity = 1) {
  const svg = icon(name, size);
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="${fill}" opacity="${opacity}">${inner}</g>`;
}

/** Read a vendored brand's viewBox without emitting anything. */
function viewBoxOf(slug) {
  return (/viewBox="([^"]+)"/.exec(readFileSync(join(ROOT, "src/web/brands", `${slug}.svg`), "utf8")) ?? [])[1] ?? "0 0 24 24";
}

/** The brand column: a rounded container with an inlined company mark. */
function brandTile(slug, t, x, y, size = 30, { selected = false, wide = false } = {}) {
  const path = join(ROOT, "src/web/brands", `${slug}.svg`);
  if (!existsSync(path)) throw new Error(`no brand ${slug}`);
  const raw = readFileSync(path, "utf8");
  // Take the drawing but keep its whitespace: collapsing runs of spaces inside a
  // path's `d` removes the separators between coordinates and silently reshapes
  // the glyph. Only the outer <svg> is dropped.
  const viewBox = (/viewBox="([^"]+)"/.exec(raw) ?? [])[1] ?? "0 0 24 24";
  const body = raw.slice(raw.indexOf(">") + 1, raw.lastIndexOf("</svg>"));
  const box = rect(x, y, wide ? size * 1.45 : size, size, t, {
    fill: selected ? t["--panel"] : t["--panel-2"],
    kind: selected ? "pressed" : "flat",
    r: dir(t) === "foundry" ? 0 : 8,
  });
  const pad = size * 0.24;
  const [vbx, vby, vbw, vbh] = viewBox.split(/\s+/).map(Number);
  // Fit the mark inside the tile without distorting it: a wordmark like Groq's is
  // 512x146, so it is scaled to the width and centred vertically.
  const w = wide ? size * 1.45 : size;
  const k = Math.min((w - pad * 2) / vbw, (size - pad * 2) / vbh);
  const tx = x + (w - vbw * k) / 2 - vbx * k;
  const ty = y + (size - vbh * k) / 2 - vby * k;
  const inner = `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})" opacity="${selected ? 0.95 : 0.62}">${body}</g>`;
  return box.defs + box.svg + inner;
}

// ---------------------------------------------------------------------------
// The dashboard, transcribed from app.js.

const ROWS = [
  ["Stripe", "stripe", "dashboard.stripe.com", "live", "4 min ago"],
  ["Groq", "groq", "console.groq.com", "prod", "12 min ago"],
  ["GitHub", "github", "github.com", "2FA", "18 min ago"],
  ["Neon", "neon", "console.neon.tech", "prod", "1 hr ago"],
  ["Vercel", "vercel", "vercel.com", "prod", "3 hr ago"],
  ["Supabase", "supabase", "supabase.com", "prod", "yesterday"],
  ["Cloudflare", "cloudflare", "dash.cloudflare.com", "prod", "yesterday"],
  ["Linear", "linear", "linear.app", "prod", "2 days ago"],
  ["Resend", "resend", "resend.com", "test", "2 days ago"],
  ["Figma", "figma", "figma.com", "prod", "3 days ago"],
  ["Notion", "notion", "notion.so", "prod", "4 days ago"],
  ["Sentry", "sentry", "sentry.io", "prod", "last week"],
];

const NAV = [
  ["vault", "Vault", "14", true],
  ["upload", "Imports", null, false],
  ["activity", "Activity", null, false],
  ["device", "Devices", null, false],
  ["gear", "Settings", null, false],
];

function dashboard(t, { width = 1280, height = 820, selected = 0, lightMode = false } = {}) {
  const foundry = dir(t) === "foundry";
  const d = [];
  const railW = 208;
  const pad = 22;

  d.push(`<rect width="${width}" height="${height}" fill="${t["--bg"]}"/>`);

  // ---- rail
  const rail = rect(0, 0, railW, height, t, { fill: foundry ? t["--panel-2"] : t["--bg"], kind: "flat", r: 0 });
  d.push(rail.defs, rail.svg);
  if (foundry) d.push(`<line x1="${railW}" y1="0" x2="${railW}" y2="${height}" stroke="${t["--line"]}"/>`);

  // mark + wordmark
  const ms = 24;
  const k = ms / 128;
  d.push(`<g transform="translate(${pad} 21) scale(${k})">
    <path d="M44 78V56a20 20 0 0 1 40 0v22" fill="none" stroke="${t["--ink"]}" stroke-width="14" stroke-linecap="round"/>
    <rect x="18" y="72" width="92" height="34" rx="10" fill="${t["--ink"]}"/>
    <circle cx="40" cy="89" r="6" fill="${t["--bg"]}"/><circle cx="88" cy="89" r="6" fill="${t["--bg"]}"/>
  </g>`);
  d.push(label(t, pad + ms + 10, 37, "hasp", { size: 19, weight: 700, family: "Archivo" }));

  // workspace switcher
  const ws = rect(pad, 56, railW - pad * 2, 46, t, { fill: t["--panel"], kind: foundry ? "flat" : "pressed", stroke: foundry ? t["--line"] : null });
  d.push(ws.defs, ws.svg);
  d.push(label(t, pad + 14, 74, "Studio Sarang", { size: 12.5, weight: 600 }));
  d.push(label(t, pad + 14, 90, "personal vault", { size: 11, role: "mut" }));

  // nav
  let ny = 124;
  for (const [ic, name, count, active] of NAV) {
    if (active) {
      const nav = rect(pad, ny, railW - pad * 2, 34, t, {
        fill: t["--panel"],
        kind: foundry ? "flat" : "lift",
        extra: foundry ? `stroke="${t["--line"]}"` : "",
      });
      d.push(nav.defs, nav.svg);
    }
    d.push(glyph(ic, pad + 12, ny + 9, 16, t["--ink"], active ? 0.95 : 0.55));
    d.push(label(t, pad + 38, ny + 22, name, { size: 13, weight: active ? 600 : 400, role: active ? "ink" : "mut" }));
    if (count) d.push(label(t, railW - pad - 10, ny + 22, count, { size: 11.5, role: "mut", anchor: "end", mono: true }));
    ny += 38;
  }

  // rail foot: idle note
  d.push(label(t, pad + 4, height - 34, "Idle lock in 4:38", { size: 11.5, role: "mut", mono: true }));

  // ---- topbar
  const cx = railW;
  d.push(label(t, cx + 32, 52, "Vault", { size: 25, weight: 600, family: "Archivo" }));
  d.push(label(t, cx + 32, 74, "14 items, sealed with one master password", { size: 12.5, role: "mut" }));

  // search
  const sw = 300;
  const sx = width - sw - 340;
  const search = rect(sx, 34, sw, 36, t, { fill: t["--panel"], kind: foundry ? "flat" : "pressed", stroke: foundry ? t["--line"] : null });
  d.push(search.defs, search.svg);
  d.push(glyph("search", sx + 12, 43, 16, t["--mut"]));
  d.push(label(t, sx + 36, 57, "Search", { size: 12.5, role: "mut" }));

  // segmented control
  const segX = width - 320;
  const segW = 152;
  const seg = rect(segX, 34, segW, 36, t, { fill: t["--panel-2"], kind: foundry ? "flat" : "pressed", stroke: foundry ? t["--line"] : null });
  d.push(seg.defs, seg.svg);
  // The segment shows the direction this frame is drawn in, so the control and
  // the surface never disagree in the same picture.
  const current = foundry ? "Foundry" : "Nightshift";
  for (const [i, [nm, on]] of [["Foundry", current === "Foundry"], ["Nightshift", current === "Nightshift"]].entries()) {
    const bx = segX + 4 + i * ((segW - 8) / 2);
    if (on) {
      const b = rect(bx, 38, (segW - 8) / 2, 28, t, { fill: t["--accent"], kind: foundry ? "flat" : "lift", r: 8 });
      d.push(b.defs, b.svg);
    }
    d.push(label(t, bx + (segW - 8) / 4, 56, nm, { size: 12, weight: on ? 600 : 400, fill: on ? t["--accent-ink"] : t["--mut"], anchor: "middle" }));
  }

  // mode toggle
  const tg = rect(width - 152, 34, 40, 36, t, { fill: t["--panel"], kind: foundry ? "flat" : "lift", stroke: foundry ? t["--line"] : null, r: dir(t) === "foundry" ? 0 : 18 });
  d.push(tg.defs, tg.svg);
  d.push(glyph(lightMode ? "sun" : "moon", width - 140, 44, 16, t["--ink"], 0.8));

  // add
  const add = rect(width - 100, 34, 68, 36, t, { fill: t["--accent"], kind: foundry ? "flat" : "lift", r: dir(t) === "foundry" ? 0 : 8 });
  d.push(add.defs, add.svg);
  d.push(glyph("plus", width - 90, 44, 15, t["--accent-ink"]));
  d.push(label(t, width - 70, 57, "Add", { size: 12.5, weight: 600, fill: t["--accent-ink"] }));

  // ---- list head
  const listX = cx + 32;
  const listW = width - listX - 372;
  d.push(label(t, listX, 122, "ALL ITEMS", { size: 10.5, role: "mut", weight: 600, mono: true }));
  d.push(label(t, listX + listW, 122, `${ROWS.length} shown`, { size: 11, role: "mut", anchor: "end" }));

  // ---- rows
  let ry = 134;
  for (const [i, [name, slug, host, tag, when]] of ROWS.entries()) {
    if (ry + 56 > height - 40) break;
    const h = 56;
    const on = i === selected;
    if (on) {
      const row = rect(listX, ry, listW, h, t, {
        fill: foundry ? t["--panel"] : t["--panel"],
        kind: foundry ? "flat" : "lift",
        extra: foundry ? `stroke="${t["--line"]}"` : "",
      });
      d.push(row.defs, row.svg);
      if (foundry) d.push(`<rect x="${listX}" y="${ry}" width="3" height="${h}" fill="${t["--accent"]}"/>`);
    } else if (foundry) {
      d.push(`<line x1="${listX}" y1="${ry + h}" x2="${listX + listW}" y2="${ry + h}" stroke="${t["--line-2"]}"/>`);
    }
    const wide = viewBoxOf(slug) !== "0 0 24 24";
    d.push(brandTile(slug, t, listX + 14, ry + 13, 30, { selected: on, wide }));
    d.push(label(t, listX + 58, ry + 25, name, { size: 13.5, weight: on ? 600 : 500 }));
    d.push(label(t, listX + 58, ry + 41, host, { size: 11.5, role: "mut", mono: true }));

    // environment tag: a glyph as well as a colour, never colour alone
    const tagW = 46 + tag.length * 4;
    const tx = listX + listW - tagW - 108;
    const pill = rect(tx, ry + 18, tagW, 20, t, { fill: t["--panel-2"], kind: foundry ? "flat" : "pressed", r: 10, stroke: foundry ? t["--line"] : null });
    d.push(pill.defs, pill.svg);
    const live = tag === "live" || tag === "prod";
    d.push(`<circle cx="${tx + 11}" cy="${ry + 28}" r="3" fill="${live ? "#3f9d6b" : t["--accent"]}"/>`);
    d.push(label(t, tx + 20, ry + 32, tag, { size: 10.5, role: "mut", mono: true }));

    d.push(label(t, listX + listW - 14, ry + 32, when, { size: 11, role: "mut", anchor: "end", mono: true }));
    ry += h;
  }

  // ---- inspector
  const ix = listX + listW + 20;
  const iw = width - ix - 24;
  const panel = rect(ix, 104, iw, 690, t, { fill: t["--panel"], kind: foundry ? "flat" : "lift", stroke: foundry ? t["--line"] : null });
  d.push(panel.defs, panel.svg);

  d.push(brandTile("stripe", t, ix + 22, 130, 44));
  d.push(label(t, ix + 22, 200, "Stripe", { size: 19, weight: 600, family: "Archivo" }));
  d.push(label(t, ix + 22, 219, "dashboard.stripe.com", { size: 11.5, role: "mut", mono: true }));

  // the secret, masked
  const field = rect(ix + 22, 240, iw - 44, 44, t, { fill: t["--panel-2"], kind: foundry ? "flat" : "pressed", stroke: foundry ? t["--line"] : null });
  d.push(field.defs, field.svg);
  d.push(label(t, ix + 36, 267, "••••••••••••••••••••••••", { size: 13, role: "mut", mono: true }));
  d.push(glyph("eye", ix + iw - 62, 254, 16, t["--mut"]));
  d.push(glyph("copy", ix + iw - 38, 254, 16, t["--mut"]));

  // one-time code card
  const codeCard = rect(ix + 22, 304, iw - 44, 116, t, { fill: t["--panel-2"], kind: foundry ? "flat" : "lift", stroke: foundry ? t["--line"] : null });
  d.push(codeCard.defs, codeCard.svg);
  d.push(label(t, ix + 40, 328, "ONE-TIME CODE", { size: 10, role: "mut", weight: 600, mono: true }));
  d.push(label(t, ix + 40, 372, "482 105", { size: 34, weight: 600, family: "Archivo", mono: false }));
  d.push(label(t, ix + 40, 394, "19 seconds left", { size: 11, role: "mut", mono: true }));
  // depletion bar, the "dial" of the references reduced to a line
  const barW = iw - 84;
  d.push(`<rect x="${ix + 40}" y="404" width="${barW}" height="4" rx="2" fill="${t["--line"]}"/>`);
  d.push(`<rect x="${ix + 40}" y="404" width="${barW * 0.63}" height="4" rx="2" fill="${t["--accent"]}"/>`);

  // metadata rows
  let my = 452;
  for (const [k, v] of [["Environment", "live"], ["Owner", "Studio Sarang"], ["Rotates", "every 90 days"], ["Updated", "4 minutes ago"]]) {
    d.push(label(t, ix + 22, my, k, { size: 11, role: "mut" }));
    d.push(label(t, ix + iw - 22, my, v, { size: 12, anchor: "end" }));
    if (foundry) d.push(`<line x1="${ix + 22}" y1="${my + 10}" x2="${ix + iw - 22}" y2="${my + 10}" stroke="${t["--line-2"]}"/>`);
    my += 34;
  }

  // actions
  const btn = rect(ix + 22, 620, iw - 44, 40, t, { fill: t["--accent"], kind: foundry ? "flat" : "lift" });
  d.push(btn.defs, btn.svg);
  d.push(glyph("copy", ix + 38, 632, 15, t["--accent-ink"]));
  d.push(label(t, ix + 60, 645, "Copy secret", { size: 12.5, weight: 600, fill: t["--accent-ink"] }));
  d.push(label(t, ix + 22, 700, "Edit item", { size: 12, role: "mut" }));
  d.push(label(t, ix + 100, 700, "Delete", { size: 12, role: "mut" }));

  return { svg: d.join("\n"), width, height };
}

// ---------------------------------------------------------------------------
// Other artwork.

/** The wordmark: the real Archivo outlines, converted to SVG paths. */
async function wordmarkSvg() {
  const fontkit = await import("fontkit");
  const font = fontkit.openSync(join(ROOT, "src/web/fonts/archivo-latin-700-normal.woff2"));
  const run = font.layout("Hasp");
  const upm = font.unitsPerEm;
  let x = 0;
  const paths = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const g = run.glyphs[i];
    const adv = run.positions[i].xAdvance;
    const d = g.path.toSVG();
    if (d) paths.push(`<path transform="translate(${x} 0) scale(1 -1)" d="${d}"/>`);
    x += adv;
  }
  return { paths: paths.join(""), width: x / upm };
}

/** Path-only wordmark, so the README can show the logo with no font fetch. */
async function logo() {
  const { paths, width } = await wordmarkSvg();
  const s = 72 / 1; // px per em
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="28" fill="#14161a"/>
  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6f9"/><stop offset="1" stop-color="#c8d0da"/></linearGradient>
  <filter id="r" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".55"/><feDropShadow dx="0" dy="-2" stdDeviation="3" flood-color="#fff" flood-opacity=".07"/></filter>
  <mask id="cut"><rect width="128" height="128" fill="#fff"/><circle cx="26" cy="47" r="7" fill="#000"/><circle cx="102" cy="47" r="7" fill="#000"/><rect x="55" y="38" width="18" height="22" rx="4" fill="#000"/></mask></defs>
  <g filter="url(#r)"><g fill="url(#p)" mask="url(#cut)">
    <path d="M6 26h116a6 6 0 0 1 6 6v30a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6Z"/>
    <rect x="30" y="72" width="68" height="13" rx="3"/>
    <path d="M22 93h84a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6V99a6 6 0 0 1 6-6Z"/>
  </g></g>
</svg>`;
}

/** Outlined type, scaled so its cap height sits on the given baseline. */
function wordmarkBody(color, size) {
  const o = outline("hasp", { size });
  return `<g fill="${color}" transform="translate(0 ${o.capHeight.toFixed(2)})">${o.paths}</g>`;
}

/** The GitHub social preview, 1280x640. */
function socialPreview(t) {
  const d = [];
  d.push(`<rect width="1280" height="640" fill="#101216"/>`);
  // a soft vignette so the plate reads as lit from the top left
  d.push(`<defs><radialGradient id="v" cx="22%" cy="10%" r="90%"><stop offset="0" stop-color="#1e242c"/><stop offset="1" stop-color="#0c0e11"/></radialGradient></defs>`);
  d.push(`<rect width="1280" height="640" fill="url(#v)"/>`);

  // the record: a sample row from the product
  const panel = rect(700, 96, 480, 300, { ...t, "--r": "14px" }, { fill: "#171b21", kind: "lift", r: 14 });
  d.push(panel.defs, panel.svg);
  d.push(brandTile("stripe", t, 732, 128, 40));
  d.push(text(788, 143, "Stripe", { size: 20, weight: 600, family: "Archivo", fill: "#e8eaed" }));
  d.push(text(788, 163, "dashboard.stripe.com", { size: 12, fill: "#7f8794", mono: true }));
  d.push(text(732, 216, "LIVE SECRET", { size: 10, weight: 600, fill: "#6c7480", mono: true }));
  d.push(text(732, 248, "••••••••••••••••••••••••••••", { size: 15, fill: "#9aa4b2", mono: true }));
  d.push(`<rect x="732" y="276" width="416" height="1" fill="#232830"/>`);
  d.push(text(732, 306, "ONE-TIME CODE", { size: 10, weight: 600, fill: "#6c7480", mono: true }));
  d.push(text(732, 350, "482 105", { size: 40, weight: 600, family: "Archivo", fill: "#eef1f5" }));
  d.push(text(960, 350, "19s", { size: 13, fill: "#7f8794", mono: true }));
  d.push(`<rect x="732" y="368" width="416" height="4" rx="2" fill="#232830"/>`);
  d.push(`<rect x="732" y="368" width="262" height="4" rx="2" fill="#7fa6d8"/>`);

  // the mark
  // The mark, from the same geometry the favicon and app icon use.
  d.push(`<g transform="translate(84 120) scale(0.98)">${relief()}</g>`);

  d.push(`<g transform="translate(84 296)">${wordmarkBody("#f2f5f8", 66)}</g>`);
  d.push(text(84, 392, "The keys you actually use, in one sealed place.", { size: 22, fill: "#9aa4b2" }));
  d.push(text(84, 424, "Nightshift and Foundry. Light and dark. Local first.", { size: 17, fill: "#6f7885" }));
  d.push(text(84, 552, "hasp", { size: 14, fill: "#59616c", mono: true }));
  d.push(glyph("lock", 141, 540, 15, "#59616c"));
  d.push(text(163, 552, "no sync, no accounts, no network", { size: 14, fill: "#59616c" }));

  return { svg: d.join("\n"), width: 1280, height: 640 };
}

// ---------------------------------------------------------------------------

async function write(name, { svg, width, height }, { png = true, jpg = false } = {}) {
  const full = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`;
  try {
    if (png) await sharp(Buffer.from(full)).png({ compressionLevel: 9 }).toFile(join(OUT, `${name}.png`));
  } catch (e) {
    writeFileSync(`/tmp/fail-${name}.svg`, full);
    const lines = full.split("\n");
    console.error(`FAILED ${name}: ${e.message.slice(0, 120)}`);
    console.error(`  lines: ${lines.length}`);
    throw e;
  }
  if (jpg) await sharp(Buffer.from(full)).jpeg({ quality: 88, mozjpeg: true }).toFile(join(OUT, `${name}.jpg`));
  return full;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // Point fontconfig at decompressed copies of the app's own woff2 files.
  rmSync(FONTDIR, { recursive: true, force: true });
  mkdirSync(FONTDIR, { recursive: true });
  for (const f of readFileSync ? [] : []) void f;
  const fonts = ["archivo-400", "archivo-500", "archivo-600", "archivo-700", "instrument-400", "instrument-500", "instrument-600", "plex-400", "plex-500"];
  const files = [
    "archivo-latin-400-normal", "archivo-latin-500-normal", "archivo-latin-600-normal", "archivo-latin-700-normal",
    "instrument-sans-latin-400-normal", "instrument-sans-latin-500-normal", "instrument-sans-latin-600-normal",
    "ibm-plex-mono-latin-400-normal", "ibm-plex-mono-latin-500-normal",
  ];
  for (const f of files) {
    const ttf = await decompress(readFileSync(join(ROOT, "src/web/fonts", `${f}.woff2`)));
    writeFileSync(join(FONTDIR, `${f}.ttf`), Buffer.from(ttf));
  }
  writeFileSync(join(FONTDIR, "fonts.conf"), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONTDIR}</dir><cachedir>${FONTDIR}/cache</cachedir></fontconfig>`);
  process.env.FONTCONFIG_FILE = join(FONTDIR, "fonts.conf");

  const nsDark = tokens("nightshift", "dark");
  const nsLight = tokens("nightshift", "light");
  const fndDark = tokens("foundry", "dark");
  const fndLight = tokens("foundry", "light");

  const first = dashboard(nsDark);
  writeFileSync("/tmp/ns-dark.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="${first.width}" height="${first.height}" viewBox="0 0 ${first.width} ${first.height}">${first.svg}</svg>`);
  await write("nightshift-dark", first);
  await write("nightshift-light", dashboard(nsLight));
  await write("foundry-dark", dashboard(fndDark));
  await write("foundry-light", dashboard(fndLight));
  await write("social", socialPreview(nsDark), { png: true, jpg: true });

  // The shipped assets: an outlined wordmark and a square icon.
  writeFileSync(join(OUT, "logo.svg"), wordmark({ size: 64, color: "#16181c" }));
  writeFileSync(join(OUT, "logo-dark.svg"), wordmark({ size: 64, color: "#e8eaed" }));
  writeFileSync(join(OUT, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Hasp">${onGround()}</svg>`);
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512">${relief()}</svg>`))
    .resize(512, 512).png().toFile(join(OUT, "icon-512.png"));
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512">${relief()}</svg>`))
    .resize(180, 180).png().toFile(join(ROOT, "src/web/apple-touch-icon.png"));

  console.log("wrote docs/screens:");
  for (const f of ["nightshift-dark", "nightshift-light", "foundry-dark", "foundry-light", "social", "logo"]) {
    const p = join(OUT, existsSync(join(OUT, f + ".png")) ? f + ".png" : f + ".svg");
    console.log("  ", f, (readFileSync(p).length / 1024).toFixed(0) + "kb");
  }
}

await main();
