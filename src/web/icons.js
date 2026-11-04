// Stroke icon set. One weight, one grid, currentColor. Shared by the app and the
// server-rendered shell so a nav item and a button never disagree.
//
// Every icon is 16px on a 16px box with a 1.4 stroke, except where noted.

const wrap = (body, size = 16) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  vault: wrap(`<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.6"/><circle cx="8" cy="8" r="2.6"/><path d="M8 5.4V3.6M8 12.4v-1.8"/>`),
  search: wrap(`<circle cx="6.9" cy="6.9" r="4.2"/><path d="M10 10 13.6 13.6"/>`),
  copy: wrap(`<rect x="5.4" y="5.4" width="7.4" height="7.4" rx="1"/><path d="M3.2 10.2V4.3a1 1 0 0 1 1-1h5.9"/>`),
  plus: wrap(`<path d="M8 3.2v9.6M3.2 8h9.6"/>`),
  lock: wrap(`<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.2"/><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7"/>`),
  unlock: wrap(`<rect x="3.2" y="7" width="9.6" height="6.4" rx="1.2"/><path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0"/>`),
  eye: wrap(`<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.9"/>`),
  eyeoff: wrap(`<path d="M6.2 4.1A6.6 6.6 0 0 1 8 3.8C12 3.8 14.4 8 14.4 8a11 11 0 0 1-2.2 2.6M4.1 5.4A11 11 0 0 0 1.6 8S4 12.2 8 12.2a6.6 6.6 0 0 0 1.8-.3"/><path d="M2.4 2.4 13.6 13.6"/>`),
  clock: wrap(`<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.4 1.6"/>`),
  key: wrap(`<circle cx="5.4" cy="8" r="2.6"/><path d="M8 8h6M11.6 8v2.2M13.4 8v1.5"/>`),
  gear: wrap(`<circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6"/>`),
  close: wrap(`<path d="M4 4l8 8M12 4l-8 8"/>`),
  download: wrap(`<path d="M8 2.6v7.6M4.8 7.2 8 10.4l3.2-3.2M2.8 12.6h10.4"/>`),
  upload: wrap(`<path d="M8 10.4V2.8M4.8 5.8 8 2.6l3.2 3.2M2.8 12.6h10.4"/>`),
  check: wrap(`<path d="M3.2 8.4 6.4 11.6 12.8 4.8"/>`),
  alert: wrap(`<path d="M8 2.6 14.4 13.4H1.6z"/><path d="M8 6.6v2.8M8 11.4v.1"/>`),
  trash: wrap(`<path d="M3 4.6h10M6.2 4.6V3.2h3.6v1.4M4.4 4.6l.6 8.2h6l.6-8.2"/>`),
  edit: wrap(`<path d="M11.2 2.6 13.4 4.8 5.6 12.6 2.8 13.2l.6-2.8z"/>`),
  sun: wrap(`<circle cx="8" cy="8" r="2.9"/><path d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1"/>`),
  moon: wrap(`<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z"/>`),
  layers: wrap(`<path d="M8 2.2 14 5.6 8 9 2 5.6z"/><path d="M2 8.8 8 12.2l6-3.4"/>`),
  activity: wrap(`<path d="M1.8 8h2.6l1.8-4.4 2.4 8.8L11 8h3.2"/>`),
  device: wrap(`<rect x="2.4" y="3.2" width="11.2" height="7.4" rx="1"/><path d="M5.6 13.2h4.8"/>`),
  refresh: wrap(`<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.4 2.6v3.2h-3.2"/>`),
  arrow: wrap(`<path d="M3.4 8h9.2M9.2 4.6 12.6 8l-3.4 3.4"/>`),
};

/** The product mark. A hasp is a hinged plate with a slot and a staple. */
export const mark = (size = 22) =>
  `<svg viewBox="0 0 28 28" width="${size}" height="${size}" aria-hidden="true" focusable="false"><rect x="2" y="4" width="24" height="9" rx="1.5" fill="currentColor"/><rect x="8" y="13" width="12" height="4" fill="currentColor" opacity=".5"/><rect x="6" y="17" width="16" height="3.4" fill="currentColor"/><circle cx="6.6" cy="8.5" r="1.5" fill="var(--bg)"/><circle cx="21.4" cy="8.5" r="1.5" fill="var(--bg)"/><rect x="12.4" y="6.4" width="3.2" height="4.2" rx="0.6" fill="var(--bg)"/></svg>`;

/** A brand mark, served from src/web/brands by slug. */
export const brandMark = (slug, alt = "") =>
  slug
    ? `<img src="brands/${encodeURIComponent(slug)}.svg" alt="${escAttr(alt)}" width="18" height="18" loading="lazy" decoding="async">`
    : "";

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
