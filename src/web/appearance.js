// Direction and mode.
//
// Two independent choices, four combinations. Both persist in localStorage so a
// reload keeps the surface you were reading. Nothing here touches the vault.
//
// Order of resolution on load: stored choice, then the OS preference for mode.
// Nightshift is the default direction: it is the surface the product leads with.
// Mode follows the system, so a first visit lands on Nightshift light or dark
// according to the reader's own setting.

export const DIRECTIONS = ["foundry", "nightshift"];
export const MODES = ["light", "dark"];

const KEY_DIR = "hasp.direction";
const KEY_MODE = "hasp.mode";

/** Read a stored value if it is one we recognise. */
function read(store, key, allowed) {
  try {
    const v = store.getItem(key);
    return allowed.includes(v) ? v : null;
  } catch {
    return null; // private mode, storage disabled
  }
}

function write(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {
    // A blocked store must not break the interface.
  }
}

/**
 * Work out the appearance to apply.
 * @param {Storage} store
 * @param {{prefersDark: boolean}} env
 * @returns {{dir: string, mode: string, stored: boolean}}
 */
export const DEFAULT_DIRECTION = "nightshift";

/** Accent styles. `colour` keeps the direction's own hue; the others remove it. */
export const ACCENTS = ["colour", "mono", "grey"];
export const DEFAULT_ACCENT = "colour";
const KEY_ACCENT = "hasp.accent";

export function resolve(store, env = { prefersDark: false }) {
  const dir = read(store, KEY_DIR, DIRECTIONS) || DEFAULT_DIRECTION;
  const storedMode = read(store, KEY_MODE, MODES);
  const mode = storedMode || (env.prefersDark ? "dark" : "light");
  const accent = read(store, KEY_ACCENT, ACCENTS) || DEFAULT_ACCENT;
  // stored tracks a real choice rather than a resolved default, so the caller can
  // tell "the reader picked this" from "this is what happens if they pick nothing".
  const stored = read(store, KEY_DIR, DIRECTIONS) !== null || storedMode !== null || read(store, KEY_ACCENT, ACCENTS) !== null;
  return { dir, mode, accent, stored };
}

/** Persist a choice. Unknown values are ignored rather than written. */
export function choose(store, { dir, mode, accent }) {
  if (DIRECTIONS.includes(dir)) write(store, KEY_DIR, dir);
  if (MODES.includes(mode)) write(store, KEY_MODE, mode);
  if (ACCENTS.includes(accent)) write(store, KEY_ACCENT, accent);
}

/** The attribute pair the stylesheet reads. */
export function attributes({ dir, mode, accent }) {
  const out = { "data-dir": dir, "data-mode": mode };
  // Only emit the attribute for a non-default accent, so the plain stylesheet path
  // is the one that runs unless someone has asked for something else.
  if (accent && accent !== DEFAULT_ACCENT) out["data-accent"] = accent;
  return out;
}

/** Human labels for the switch, kept in one place so the UI stays consistent. */
export const LABELS = {
  foundry: "Foundry",
  nightshift: "Nightshift",
  light: "Light",
  dark: "Dark",
};

export const NOTES = {
  foundry: "Parts catalog. Square corners, solid ink header, one oxide accent.",
  nightshift: "Neumorphic. Controls sit in the surface, paired light and dark shadows.",
};
