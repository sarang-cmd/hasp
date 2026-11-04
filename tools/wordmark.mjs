// Turns the app's own typeface into outlines.
//
// A README is rendered on GitHub, which will not serve src/web/fonts, and an SVG
// that depends on a webfont falls back to whatever the reader has. So the wordmark
// is converted to paths here and written out as a self-contained SVG. The
// letterforms are the real Archivo 700 the interface uses, not a substitute.

import * as fontkit from "fontkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Path data for a string, at a given size in px, on its own baseline. */
export function outline(word, { weight = 700, size = 64 } = {}) {
  const file = join(ROOT, `src/web/fonts/archivo-latin-${weight}-normal.woff2`);
  const font = fontkit.openSync(file);
  const run = font.layout(word);
  const k = size / font.unitsPerEm;

  let x = 0;
  const parts = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const g = run.glyphs[i];
    const d = g.path.toSVG();
    if (d) {
      // The glyph outlines are y-up with the origin on the baseline; SVG is y-down.
      parts.push(`<path transform="translate(${(x * k).toFixed(3)} 0) scale(${k.toFixed(5)} -${k.toFixed(5)})" d="${d}"/>`);
    }
    x += run.positions[i].xAdvance;
  }

  return {
    paths: parts.join(""),
    width: x * k,
    ascent: font.ascent * k,
    capHeight: font.capHeight * k,
  };
}

/** A wordmark SVG: mark plus outlined type, baseline aligned. */
export function wordmark({ size = 64, gap = 18, color = "#e8eaed", markSize = null } = {}) {
  const w = outline("hasp", { size: size * 0.82 });
  const ms = markSize ?? size * 1.06;
  // Centre the mark on the x-height of the word rather than the cap height: the
  // lowercase word sits lower than a capital would, and the optical centre moves.
  const top = size * 0.34;
  const height = Math.round(size * 1.1);
  const width = Math.round(ms + gap + w.width + 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="hasp">
  <g transform="translate(0 ${(height - ms) / 2})" fill="${color}">
    <path d="M${44 * (ms / 128)} ${78 * (ms / 128)}V${56 * (ms / 128)}a${20 * (ms / 128)} ${20 * (ms / 128)} 0 0 1 ${40 * (ms / 128)} 0v${22 * (ms / 128)}" fill="none" stroke="${color}" stroke-width="${14 * (ms / 128)}" stroke-linecap="round"/>
    <rect x="${18 * (ms / 128)}" y="${72 * (ms / 128)}" width="${92 * (ms / 128)}" height="${34 * (ms / 128)}" rx="${10 * (ms / 128)}"/>
  </g>
  <g fill="${color}" transform="translate(${ms + gap} ${top + w.capHeight})">${w.paths}</g>
</svg>`;
}

export const FONT_FILE = (weight = 700) => join(ROOT, `src/web/fonts/archivo-latin-${weight}-normal.woff2`);
