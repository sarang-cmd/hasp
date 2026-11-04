// Builds a geometry index of the vendored brand marks.
//
// The app draws 586 company marks in fixed-size tiles, and they are not all the
// same shape: most are square icons on a 24px grid, but a few are wordmarks with
// extreme aspect ratios (Groq's is 512x146). Rendering those into a square box
// distorts them, which is exactly what happened in the first screenshot pass.
//
// Rather than eyeballing which ones are wide, this reads every file and records
// what is actually in it: the viewBox, the aspect class, how many paths carry the
// drawing, and which colours appear. The client can then size a tile from data
// instead of guessing, and the index is derived entirely from the files, so it
// cannot drift from them.
//
// Run: node tools/brandindex.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BRANDS = join(ROOT, "src/web/brands");
const OUT = join(ROOT, "src/web/brands.index.json");

/** Everything one mark needs to be laid out without distortion. */
export function describe(source) {
  const viewBox = (/viewBox="([^"]+)"/.exec(source) ?? [])[1] ?? "0 0 24 24";
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  const [, , w, h] = parts.length === 4 ? parts : [0, 0, 24, 24];
  const ratio = h === 0 ? 1 : w / h;

  // Three classes is enough to drive the layout: square icons, marks that are a
  // bit wider than tall, and full wordmarks that need their own row treatment.
  const aspect = ratio > 2.2 ? "wordmark" : ratio > 1.25 ? "wide" : "square";

  const paths = (source.match(/<path[\s>]/g) ?? []).length;
  const colors = [...new Set([...source.matchAll(/fill="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1].toLowerCase()))].sort();

  return { viewBox: [w, h], aspect, paths, colors };
}

/** The whole index, read from the directory. */
export function build() {
  const index = {};
  for (const file of readdirSync(BRANDS).filter((f) => f.endsWith(".svg")).sort()) {
    index[file.replace(/\.svg$/, "")] = describe(readFileSync(join(BRANDS, file), "utf8"));
  }
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = build();
  writeFileSync(OUT, JSON.stringify(index, null, 2) + "\n");
  const classes = Object.values(index).reduce((a, m) => ((a[m.aspect] = (a[m.aspect] ?? 0) + 1), a), {});
  console.log(`brands.index.json: ${Object.keys(index).length} marks`);
  console.log(`  ${classes.square ?? 0} square, ${classes.wide ?? 0} wide, ${classes.wordmark ?? 0} wordmark`);
}
