// The Hasp mark, in one geometry, rendered four ways.
//
// A hasp is a hinged plate that a padlock closes over. The mark is that object
// front on: a shackle rising out of a heavy plate, and two bolt holes that say
// "hinged fitting" rather than "padlock". The bolt holes are the whole idea; a
// plain padlock is a stock glyph, a bolted one is not, and they survive being
// scaled to 16px where any finer detail would disappear.
//
// Everything here is generated from the same paths so the favicon, the app icon,
// the README logo and the social banner can never drift apart.

const C = {
  ground: "#14161a",
  plate: "#e8eaed",
  accent: "#7fa6d8",
};

// Geometry on a 128 grid. The shackle is a stroke; the plate is a fill.
const SHACKLE = "M44 78V56a20 20 0 0 1 40 0v22";
const PLATE = `<rect x="18" y="72" width="92" height="34" rx="10"/>`;
const BOLTS = [["40", "89"], ["88", "89"]];

/** The bare mark: one colour, no ground. `currentColor` friendly. */
export function bare({ color = "currentColor" } = {}) {
  return `<path d="${SHACKLE}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>
<g fill="${color}">${PLATE}</g>
<g fill="${C.ground}">${BOLTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6"/>`).join("")}</g>`;
}

/** The mark on a ground, with the holes cut through rather than painted over. */
export function onGround({ ground = C.ground, plate = C.plate } = {}) {
  const holes = BOLTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="#000"/>`).join("");
  return `<rect width="128" height="128" rx="28" fill="${ground}"/>
<defs><mask id="hasp-bolts"><rect width="128" height="128" fill="#fff"/>${holes}</mask></defs>
<path d="${SHACKLE}" fill="none" stroke="${plate}" stroke-width="14" stroke-linecap="round"/>
<g fill="${plate}" mask="url(#hasp-bolts)">${PLATE}</g>`;
}

/** The app icon: the ground version plus the soft relief Nightshift is built on. */
export function relief({ ground = C.ground } = {}) {
  const holes = BOLTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="#000"/>`).join("");
  return `<defs>
  <linearGradient id="hasp-ground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2027"/><stop offset="1" stop-color="#0f1115"/></linearGradient>
  <linearGradient id="hasp-plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6f9"/><stop offset="1" stop-color="#c9d1db"/></linearGradient>
  <filter id="hasp-lift" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".55"/><feDropShadow dx="0" dy="-2" stdDeviation="3" flood-color="#fff" flood-opacity=".07"/></filter>
  <mask id="hasp-bolts"><rect width="128" height="128" fill="#fff"/>${holes}</mask>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#hasp-ground)"/>
  <g filter="url(#hasp-lift)">
    <path d="${SHACKLE}" fill="none" stroke="url(#hasp-plate)" stroke-width="14" stroke-linecap="round"/>
    <g fill="url(#hasp-plate)" mask="url(#hasp-bolts)">${PLATE}</g>
  </g>`;
}

/** A complete square SVG document, for a favicon or a file on disk. */
export function doc(body, { size = 128, label = "Hasp" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}" role="img" aria-label="${label}">${body}</svg>`;
}

export const GROUND = C;
