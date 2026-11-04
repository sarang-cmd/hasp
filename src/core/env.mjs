// Minimal .env loading, so the app needs no dependency to read one.
//
// Node 22 has --env-file, but that is a flag every command has to remember. This
// reads .env once at startup if present, and does nothing if it is not. Existing
// process.env values win, so an explicit environment overrides a file.

import { readFileSync, existsSync } from "node:fs";

/**
 * Parse the .env dialect: KEY=value, # comments, optional surrounding quotes, and
 * a leading `export` that some editors add.
 */
export function parse(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // Do not overwrite what the real environment already set.
    out[key] = value;
  }
  return out;
}

/** Load a file into process.env. Returns the keys it set, for a startup log. */
export function load(file = ".env", env = process.env) {
  if (!existsSync(file)) return [];
  const values = parse(readFileSync(file, "utf8"));
  const applied = [];
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
