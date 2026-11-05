// The application. Renders the vault from the server's decrypted view, keeps the
// selection and filters in the URL hash so a refresh lands where you were, and
// hands every mutation back to the server.
//
// The server sends values to this page because the page is the vault. The plan's
// rule is that plaintext never reaches the *server's* storage, and it does not:
// what arrives here was decrypted in the request that produced it.

import { resolve, choose, attributes, DIRECTIONS, MODES, LABELS, NOTES } from "./appearance.js";
import { icons, mark, brandMark } from "./icons.js";
import BRAND_INDEX from "./brands.index.json" with { type: "json" };
import { buildTour } from "./tour.js";

/* ---------------------------------------------------------------- state */

const state = {
  view: "vault", // vault | import | activity | devices | settings
  // What /api/sync/status last said. Null means "not asked yet", which is different
  // from "not paired", and the panel says which.
  sync: null,
  // Conflicts from the sync log. Null means "not asked yet", which is not the same
  // as "none", and the panel says which.
  conflicts: null,
  // The comparison currently open: a comparison, an error, or null.
  conflictView: null,
  // The activity log. Null means "not asked yet", which is not the same as empty.
  activity: null,
  activityCapped: null,
  // Deleted items that can be brought back. Null means "not asked yet".
  deleted: null,
  selectedId: null,
  query: "",
  type: "all",
  env: "all",
  items: [],
  themes: {},
  meta: {},
  timer: null,
  revealUntil: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------------------------------------------------------- api */

/**
 * A 401 means one of two things, and they are not the same.
 *
 *   - the session lapsed, so the page is stale and a reload is right
 *   - the password was wrong at the unlock gate, so a reload would wipe the
 *     message the user needs
 *
 * The unlock route is exempt; every other route reloads on 401.
 */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (res.status === 401 && path !== "/api/unlock") {
    location.reload();
    throw new Error("Session expired");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    // Carry the status and the server's Retry-After so the caller can tell a
    // throttle from a plain rejection. A 429 is the only one with a countdown.
    err.status = res.status;
    err.retryAfter = Number(res.headers.get("retry-after")) || 0;
    throw err;
  }
  // Any successful request counts as activity on the server too, so the warning
  // is rearmed from now rather than left ticking from boot.
  cancelIdleWarning();
  scheduleIdleWarning(state.meta?.idleMs);
  return body;
}

/* ---------------------------------------------------------------- appearance */

const store = (() => {
  try {
    localStorage.getItem("x");
    return localStorage;
  } catch {
    // A shim, so the rest of the code needs no branches.
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
  }
})();

function applyAppearance(next) {
  const root = document.documentElement;
  // attributes() omits data-accent for the default, so a stale mono has to be
  // cleared explicitly or switching back to Colour would do nothing.
  root.removeAttribute("data-accent");
  for (const [k, v] of Object.entries(attributes(next))) root.setAttribute(k, v);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = next.mode === "dark" ? (next.dir === "foundry" ? "#14140f" : "#14161a") : next.dir === "foundry" ? "#e8e6e0" : "#e4e8ee";
  renderSwitches();
}

function currentAppearance() {
  const root = document.documentElement;
  return { dir: root.dataset.dir, mode: root.dataset.mode, accent: root.dataset.accent || "colour" };
}

function setAppearance(next) {
  choose(store, next);
  applyAppearance(next);
  toast(`${LABELS[next.dir]}, ${LABELS[next.mode].toLowerCase()} mode`);
}

function renderSwitches() {
  const host = $(".switches");
  if (!host) return;
  const { dir, mode } = currentAppearance();
  host.innerHTML = `
    <div class="seg" role="group" aria-label="Design direction">
      ${DIRECTIONS.map(
        (d) => `<button type="button" data-dir-switch="${d}" aria-pressed="${d === dir}" title="${esc(NOTES[d])}">${LABELS[d]}</button>`
      ).join("")}
    </div>
    <div class="seg" role="group" aria-label="Colour mode">
      ${MODES.map(
        (m) => `<button type="button" data-mode-switch="${m}" aria-pressed="${m === mode}" aria-label="${LABELS[m]} mode">${icons[m]}<span class="sr-only">${LABELS[m]}</span></button>`
      ).join("")}
    </div>`;
}

/* ---------------------------------------------------------------- render */

/** Slugs that have a vendored mark. Anything else falls back to a letter. */
const BRAND_SLUGS = new Set(Object.keys(BRAND_INDEX));

function tileFor(item) {
  // Only trust a slug that we actually vendored. An imported item, or one typed
  // with a typo, otherwise renders an <img> pointing at a 404: a broken-image
  // glyph in a 30px tile, which looks like the product failed rather than like
  // the brand was unknown.
  if (item.brand && BRAND_SLUGS.has(item.brand)) {
    const aspect = BRAND_INDEX[item.brand].aspect;
    return `<span class="tile${aspect === "square" ? "" : ` tile--${aspect}`}">${brandMark(item.brand, "")}</span>`;
  }
  const letter = (item.service || item.name || "?").trim().charAt(0).toUpperCase();
  return `<span class="tile tile--text">${esc(letter)}</span>`;
}

const ENV_GLYPH = { prod: "\u25B2", live: "\u25B2", staging: "\u25C6", dev: "\u25CF", "": "" };
const ENV_LABEL = { prod: "prod", live: "live", staging: "staging", dev: "dev", "": "no env" };

function tagFor(env) {
  const key = env || "";
  return `<span class="tag tag--${key || "none"}"><i aria-hidden="true">${ENV_GLYPH[key] || ""}</i>${ENV_LABEL[key]}</span>`;
}

const TYPE_LABEL = { "api-key": "API key", "backup-codes": "Backup codes", totp: "One-time code", note: "Note" };

function relTime(iso) {
  if (!iso) return "Never used";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never used";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

function counts() {
  const c = { all: state.items.length, "api-key": 0, "backup-codes": 0, totp: 0, note: 0 };
  for (const i of state.items) c[i.type] = (c[i.type] || 0) + 1;
  return c;
}

/**
 * The rows to show.
 *
 * Text matching is not done here. A query goes to the vault, which answers from the
 * blind index: the item is stored as ciphertext plus a set of keyed hashes, so a
 * search never needs the plaintext of a field the query did not match, and the
 * words typed are not stored anywhere.
 *
 * That means state.items already holds the matches when a query is active. The two
 * filters below are the ones that cannot be indexed, because they are exact values
 * the client already has.
 */
function visible() {
  return state.items.filter((i) => {
    if (state.type !== "all" && i.type !== state.type) return false;
    if (state.env !== "all" && (i.env || "") !== state.env) return false;
    return true;
  });
}

/**
 * Ask the vault for the rows matching a query.
 *
 * Debounced, because every keystroke would otherwise be a round trip and one
 * decryption pass. An empty query is not debounced: clearing the field should bring
 * the list back at once.
 */
let searchTimer = null;
let searchSeq = 0;

function searchNow(query) {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const run = async () => {
    try {
      const data = await api(`/api/state?q=${encodeURIComponent(query)}`);
      // A slower earlier request must not overwrite a newer result.
      if (seq !== searchSeq) return;
      state.items = data.items;
      state.meta = data.meta || state.meta;
    } catch (err) {
      if (seq === searchSeq) showError(err.message);
      return;
    }
    const content = $(".content");
    if (!content) return;
    const rows = visible();
    if (!rows.some((i) => i.id === state.selectedId)) {
      state.selectedId = rows.at(0)?.id ?? null;
      state.revealUntil = 0;
    }
    content.innerHTML = renderVault().body;
    const inspector = $(".inspector");
    if (inspector && !state.selectedId) {
      inspector.outerHTML = `<aside class="inspector" aria-label="Item detail"><div class="empty"><strong>No match</strong>Nothing in the vault matches "${esc(state.query)}".</div></aside>`;
    }
  };
  if (!query.trim()) return run();
  searchTimer = setTimeout(run, 120);
}

function renderVault() {
  const c = counts();
  const rows = visible();
  const sel = state.items.find((i) => i.id === state.selectedId) || null;

  const filters = `
    <div class="filters" role="group" aria-label="Filters">
      ${["all", "api-key", "backup-codes", "totp"]
        .map((t) => {
          const label = t === "all" ? "All" : TYPE_LABEL[t];
          const n = t === "all" ? c.all : c[t] || 0;
          return `<button class="chip" type="button" data-type="${t}" aria-pressed="${state.type === t}">${label} <b>${n}</b></button>`;
        })
        .join("")}
      <button class="chip chip--end" type="button" data-env-cycle aria-label="Filter by environment, currently ${ENV_LABEL[state.env]}">
        Environment, ${state.env === "all" ? "all" : ENV_LABEL[state.env]}
      </button>
    </div>`;

  const list = `
    <section class="list" aria-label="Vault items">
      <div class="list-head" aria-hidden="true">
        <span>Item</span><span>Environment</span><span>Type</span><span>Last used</span>
      </div>
      ${
        rows.length === 0
          ? `<div class="empty"><strong>Nothing here</strong>${state.query ? `No item matches "${esc(state.query)}".` : "Try another filter."}</div>`
          : rows
              .map(
                (i) => `<button class="row" type="button" data-id="${esc(i.id)}" aria-selected="${i.id === state.selectedId}">
          <span class="row-main">${tileFor(i)}<span><span class="row-name">${esc(i.name)}</span><span class="row-sub">${esc(i.host || i.service || "")}</span></span></span>
          ${tagFor(i.env)}
          <span class="rtype">${TYPE_LABEL[i.type] || i.type}</span>
          <span class="rwhen">${relTime(i.lastUsedAt)}</span>
        </button>`
              )
              .join("")
      }
    </section>`;

  const inspector = sel ? renderInspector(sel) : `<aside class="inspector" aria-label="Item detail"><div class="empty">Select an item to see its detail.</div></aside>`;

  return { title: "Vault", sub: `${c.all} items, ${new Set(state.items.map((i) => i.service || i.name)).size} services`, filters, body: list + inspector };
}

function renderInspector(item) {
  const revealed = state.revealUntil > Date.now();
  const value = item.value || "";
  const shown = revealed ? esc(value) : `${esc(value.slice(0, 12))}<em>${"\u2022".repeat(Math.min(12, Math.max(4, value.length - 12)))}</em>${esc(value.slice(-4))}`;

  const secretBlock =
    item.type === "totp"
      ? `<div class="totp-card">
           <span class="flabel">One-time code</span>
           <div class="totp-code" data-totp="${esc(item.totp.secret)}">${esc(formatCode(item.totp))}</div>
           <div class="meter" aria-hidden="true"><i data-meter style="width:100%"></i></div>
           <div class="totp-meta"><span data-countdown>—</span><span>${esc(item.totp.issuer || "")} ${esc(item.totp.account || "")}</span></div>
           <div><button class="btn btn--small" type="button" data-copy-totp>${icons.copy} Copy code</button></div>
         </div>`
      : item.type === "backup-codes"
      ? `<div class="field">
           <span class="flabel">Backup codes, ${(item.codes || []).filter((c) => !c.usedAt).length} of ${(item.codes || []).length} unused</span>
           <div class="codes">
             ${(item.codes || [])
               .map(
                 (c, n) => `<div class="code-row${c.usedAt ? " is-used" : ""}" data-code="${esc(c.code)}" data-index="${n}">
                 <span>${esc(c.code)}</span>
                 <button class="btn btn--small btn--quiet" type="button" data-copy-code="${n}">${icons.copy}<span class="sr-only">Copy code ${n + 1}</span></button>
                 ${c.usedAt ? "" : `<button class="btn btn--small btn--quiet" type="button" data-spend-code="${n}">Used</button>`}
               </div>`
               )
               .join("")}
           </div>
           <p class="hint">One code at a time. Copying a code does not mark it used.</p>
         </div>`
      : item.type === "note"
      ? `<div class="field">
           <span class="flabel">Note</span>
           <p class="fvalue" style="white-space:pre-wrap">${esc(item.notes)}</p>
         </div>`
      : `<div class="field">
           <span class="flabel">Secret</span>
           <div class="secret">
             <code data-secret>${shown}</code>
             <button class="btn btn--small" type="button" data-copy>${icons.copy} Copy</button>
             <button class="btn btn--small btn--quiet" type="button" data-reveal aria-pressed="${revealed}">${revealed ? "Hide" : "Reveal"}</button>
           </div>
           <p class="hint">Clipboard clears after 30 seconds.</p>
         </div>`;

  const facts = [
    ["Environment", tagFor(item.env)],
    ["Type", `<span class="fvalue">${TYPE_LABEL[item.type] || esc(item.type)}</span>`],
    ["Updated", `<span class="fvalue">${new Date(item.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}</span>`],
    ["Version", `<span class="fvalue mono">v${item.version}</span>`],
  ];

  return `<aside class="inspector" aria-label="Item detail">
    <div class="insp-head">${tileFor(item)}<div><h2>${esc(item.name)}</h2><p>${esc(TYPE_LABEL[item.type] || item.type)}${item.host ? `, ${esc(item.host)}` : ""}</p></div></div>
    ${secretBlock}
    <div class="fieldgrid">
      ${facts.map(([k, v]) => `<div><span class="flabel">${k}</span>${v}</div>`).join("")}
    </div>
    <div class="why">
      <span class="flabel">Why Hasp suggests this</span>
      <p>${esc(item.why || `Label reads ${ENV_LABEL[item.env] || "no environment"}. Last use was ${relTime(item.lastUsedAt).toLowerCase()}.`)}</p>
    </div>
    <div class="activity">
      <span class="flabel">Activity</span>
      <ul>
        <li><span>Copied in Chrome</span><span>${relTime(item.lastUsedAt)}</span></li>
        <li><span>Version recorded</span><span>v${item.version}</span></li>
        <li><span>Added</span><span>${new Date(item.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></li>
      </ul>
    </div>
    <div class="insp-foot">
      <button class="btn btn--small btn--quiet" type="button" data-edit>${icons.edit} Edit item</button>
      <button class="btn btn--small btn--quiet btn--danger" type="button" data-delete>${icons.trash} Delete</button>
    </div>
  </aside>`;
}

function formatCode(totp) {
  return String(totp.code || "------");
}

/* ---------------------------------------------------------------- other views */

function renderImport() {
  return {
    title: "Import",
    sub: "Parsing runs in this process. Nothing is uploaded.",
    filters: "",
    body: `<div class="page">
      <div class="panel">
        <h2>Bring in what you already have</h2>
        <p>Google Keep Takeout, password manager CSV, otpauth links, and the JSON exports of Aegis, 2FAS, Raivo, Bitwarden, Google Authenticator and Microsoft Authenticator. Every parsed field carries a confidence score, and anything uncertain goes to review before it is stored.</p>
        <div class="drop" tabindex="0" role="button" aria-label="Choose a file to import">
          ${icons.upload}
          <strong>Drop a file, or choose one</strong>
          <span>Keep .json, Keep .html, .csv, an authenticator .json export, or .txt with otpauth links</span>
          <input type="file" hidden accept=".json,.html,.txt,.csv" aria-hidden="true">
        </div>
      </div>
      <div class="panel">
        <h2>Paste text instead</h2>
        <p>A Keep note body, a list of otpauth:// links, or a block of codes.</p>
        <textarea class="textarea" id="paste" placeholder="otpauth://totp/GitHub:you@example.com?secret=JBSWY3DPEHPK3PXP"></textarea>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn--primary" type="button" data-parse-paste>${icons.upload} Parse</button>
        </div>
      </div>
      <div id="import-result"></div>
    </div>`,
  };
}

function renderActivity() {
  const entries = state.activity;
  const label = {
    created: "added",
    edited: "edited",
    copied: "copied",
    deleted: "deleted",
    restored: "restored",
    synced: "synced",
  };
  return {
    title: "Activity",
    sub: "What happened in this vault",
    filters: "",
    body: `<div class="page"><div class="panel">
      <h2>Recent activity</h2>
      <p>What was added, edited, copied or deleted, newest first. Names are kept so the
        list can say which item it was. Values, notes and one-time codes never appear
        here, and neither does anything you searched for.</p>
      <div class="activity" style="border-top:none;padding-top:14px">
        ${entries === null
          ? `<p class="hint">Reading the log…</p>`
          : entries.length === 0
          ? `<p class="hint">Nothing yet. Copy an item and it will appear here.</p>`
          : `<ul>
              ${entries
                .map(
                  (e) => `<li><span>${esc(e.name || "an item")} ${label[e.action] || esc(e.action)}</span><span>${relTime(e.at)}</span></li>`
                )
                .join("")}
            </ul>`}
      </div>
      <p class="hint" style="margin-top:14px">The log keeps the last ${state.activityCapped || 400}
        events. It is a file beside the vault, not a service, and it is deleted when you
        delete the vault.</p>
      <h2 style="margin-top:26px">Deleted</h2>
      <p>An item you deleted is kept as a record so the change can sync. It is still
        sealed, which is why bringing one back needs no export and no backup.</p>
      <div data-deleted style="margin-top:12px">
        ${state.deleted === null
          ? `<p class="hint">Reading…</p>`
          : state.deleted.length === 0
          ? `<p class="hint">Nothing deleted.</p>`
          : `<ul class="activity" style="border-top:none;padding-top:0">
              ${state.deleted
                .map(
                  (i) => `<li><span>${esc(i.name)} <span class="hint">${esc(i.type)}</span></span>
                    <span>${relTime(i.deletedAt)} <button class="btn btn--small" type="button" data-restore="${esc(i.id)}">Restore</button></span></li>`
                )
                .join("")}
            </ul>`}
      </div>
    </div></div>`,
  };
}

/**
 * Read the log.
 *
 * Runs after paint, like the devices and settings panels. It is a real request because
 * the log is the server's, and a client-side reconstruction from item timestamps could
 * not tell a copy from an edit, which is the thing it got wrong before.
 */
async function loadActivity() {
  try {
    const data = await api("/api/activity");
    state.activity = data.entries;
    state.activityCapped = data.capped;
  } catch {
    state.activity = [];
  }
  try {
    state.deleted = (await api("/api/items/deleted")).items;
  } catch {
    state.deleted = [];
  }
  if (state.view === "activity") render();
}

function renderDevices() {
  return {
    title: "Devices",
    sub: "Where this vault is unlocked, and what may read codes",
    filters: "",
    body: `<div class="page">
      <div class="panel">
        <h2>This machine</h2>
        <p>The vault key is held in memory by the server for the length of a session. Closing the session drops it.</p>
        <div class="fieldgrid" style="margin-top:16px">
          <div><span class="flabel">This browser</span><span class="fvalue">Active session</span></div>
          <div><span class="flabel">Idle lock</span><span class="fvalue">${Math.round((state.meta.idleMs || 300000) / 60000)} minutes</span></div>
          <div><span class="flabel">Desktop app</span><span class="fvalue">Same session, same server</span></div>
          <div><span class="flabel">Browser extension</span><span class="fvalue">Same session, same server</span></div>
        </div>
      </div>
      <div class="panel" id="pair-panel">
        <h2>Pair a phone</h2>
        <p>A paired phone can read the current one-time codes. It cannot read a stored secret, a backup code set, or the vault file.</p>
        <div id="pair-body"><button class="btn btn--primary" type="button" data-pair-start>Show a pairing code</button></div>
      </div>
      <div class="panel">
        <h2>Paired devices</h2>
        <div id="pair-devices"><p class="hint">Reading the device list.</p></div>
      </div>
    </div>`,
  };
}

/**
 * The sync panel body.
 *
 * Four states, and the copy differs in each, because "sync is off" and "sync has
 * never been asked about" are different things and a single "not connected" line
 * would blur them.
 */
function renderSyncBody() {
  const body = $("[data-sync-body]");
  if (!body) return;
  const s = state.sync;
  if (!s) {
    body.innerHTML = `<p class="hint">Checking…</p>`;
    return;
  }
  if (!s.paired) {
    body.innerHTML = `
      <div class="fieldgrid">
        <div><span class="flabel">State</span><span class="fvalue">Off</span></div>
        <div><span class="flabel">Stored on the other side</span><span class="fvalue">${s.held ?? 0} records</span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" type="button" data-sync-start>Turn sync on</button>
      </div>`;
    return;
  }
  const shown = state.syncToken;
  body.innerHTML = `
    <div class="fieldgrid">
      <div><span class="flabel">State</span><span class="fvalue">On</span></div>
      <div><span class="flabel">Where</span><span class="fvalue">${esc(s.url || "this machine")}</span></div>
      <div><span class="flabel">Stored on the other side</span><span class="fvalue">${s.held ?? 0} records</span></div>
      <div><span class="flabel">Vault sequence</span><span class="fvalue">${s.seq ?? 0}</span></div>
    </div>
    ${shown ? `<div class="error" style="margin-top:12px;color:var(--warn);border-color:var(--warn)" data-sync-token>
      <div><strong>Write token, shown once.</strong> Copy it now. Only a hash is kept, so it
        cannot be shown again, only rotated.</div>
      <code style="display:block;margin-top:8px;word-break:break-all">${esc(shown)}</code>
    </div>` : ""}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" type="button" data-sync-round>Sync now</button>
      <button class="btn btn--quiet" type="button" data-sync-rotate>Rotate token</button>
      <button class="btn btn--quiet" type="button" data-sync-off>Turn sync off</button>
    </div>`;
}

/** Read the current pairing. Called after paint, like the devices panel. */
async function loadSync() {
  try {
    state.sync = await api("/api/sync/status");
  } catch {
    state.sync = { paired: false, held: 0, unknown: true };
  }
  renderSyncBody();
  if (state.sync?.paired) {
    try {
      const { conflicts } = await api("/api/sync/conflicts");
      state.conflicts = conflicts;
    } catch {
      state.conflicts = null;
    }
    renderConflicts();
  }
}

/**
 * The conflict log, under the sync panel.
 *
 * A conflict that only appears in a toast is gone in two and a half seconds, which
 * is not a log. This renders what the server kept, and it names each item by looking
 * the id up locally, because the server never had a name to give.
 */
function renderConflicts() {
  const host = $("[data-sync-conflicts]");
  if (!host) return;
  const list = state.conflicts;
  if (!list || !list.length) {
    host.innerHTML = `<p class="hint">No conflicts. Nothing has been changed on two machines at once.</p>`;
    return;
  }
  host.innerHTML = `<ul class="activity" style="border-top:none;padding-top:0">
    ${list
      .map((c) => {
        const item = state.items.find((i) => i.id === c.id);
        const name = item ? item.name : "an item you have since deleted";
        return `<li><span>${esc(name)} changed on two machines</span>
          <span>${relTime(c.at)} <button class="btn btn--small" type="button" data-conflict-open="${esc(c.id)}"${item ? "" : " disabled"}>Compare</button></span></li>`;
      })
      .join("")}
  </ul>
  <p class="hint">The write that arrived first was kept. Nothing was merged, because the
    store cannot read either side. Compare opens both copies and keeps the one you pick.</p>`;
  if (state.conflictView) renderConflictView();
}

/**
 * Both sides of one conflict, with a field by field diff.
 *
 * The remote side is decrypted by the server, because only the server holds the vault
 * key and the store's copy is ciphertext. That is the one route that returns plaintext
 * from the store, and it is why this is behind a session like every other item route.
 */
function renderConflictView() {
  const host = $("[data-conflict-view]");
  if (!host) return;
  const view = state.conflictView;
  if (!view) {
    host.innerHTML = "";
    return;
  }
  if (view.error) {
    host.innerHTML = `<div class="error">${esc(view.error)}</div>`;
    return;
  }
  const rows = view.fields
    .filter((f) => f.differs)
    .map(
      (f) => `<tr>
        <th scope="row">${esc(f.field)}</th>
        <td>${f.local === null ? `<em class="hint">not set</em>` : `<code>${esc(String(f.local))}</code>`}</td>
        <td>${f.remote === null ? `<em class="hint">not set</em>` : `<code>${esc(String(f.remote))}</code>`}</td>
      </tr>`
    )
    .join("");
  host.innerHTML = `
    <p class="hint">This machine holds rev ${view.local.rev ?? "-"}. The store holds rev
      ${view.remote.rev ?? "-"}. ${view.differs === 1 ? "1 field differs" : `${view.differs} fields differ`}.</p>
    ${view.differs === 0 ? `<p class="hint">The two copies agree. Nothing to decide.</p>` : `
    <table class="diff" style="width:100%;border-collapse:collapse;margin-top:10px">
      <thead><tr><th scope="col">Field</th><th scope="col">This machine</th><th scope="col">The other one</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" type="button" data-conflict-keep="local">Keep this machine's copy</button>
      <button class="btn btn--quiet" type="button" data-conflict-keep="remote">Keep the other machine's copy</button>
      <button class="btn btn--quiet" type="button" data-conflict-close>Cancel</button>
    </div>`}`;
}

function renderSettings() {
  const { dir, mode, accent } = currentAppearance();
  return {
    title: "Settings",
    sub: "Appearance, security and data",
    filters: "",
    body: `<div class="page">
      <div class="panel">
        <h2>Appearance</h2>
        <p>Direction and mode are independent choices. Both are remembered on this device only.</p>
        <div class="fieldset" style="margin-top:14px;gap:18px">
          <div>
            <span class="flabel">Direction</span>
            <div class="seg" role="group" aria-label="Design direction" style="margin-top:6px">
              ${DIRECTIONS.map((d) => `<button type="button" data-dir-switch="${d}" aria-pressed="${d === dir}">${LABELS[d]}</button>`).join("")}
            </div>
            <p class="hint">${esc(NOTES[dir])}</p>
          </div>
          <div>
            <span class="flabel">Accent</span>
            <div class="seg" role="group" aria-label="Accent style" style="margin-top:6px">
              ${["colour", "mono", "grey"].map((a) => `<button type="button" data-accent-switch="${a}" aria-pressed="${a === accent}">${a === "colour" ? "Colour" : a === "mono" ? "Black or white" : "Grey"}</button>`).join("")}
            </div>
            <p class="hint">${accent === "colour" ? "The direction keeps its own accent." : accent === "mono" ? "Black on light, white on dark. No hue." : "A neutral tone, for less visual pull."}</p>
          </div>
          <div>
            <span class="flabel">Walkthrough</span>
            <div style="margin-top:6px">
              <button class="btn btn--small" type="button" data-tour-start>Show me around</button>
            </div>
            <p class="hint">Replays the guided tour. It uses sample data only.</p>
          </div>
          <div>
            <span class="flabel">Mode</span>
            <div class="seg" role="group" aria-label="Colour mode" style="margin-top:6px">
              ${MODES.map((m) => `<button type="button" data-mode-switch="${m}" aria-pressed="${m === mode}">${icons[m]}<span style="margin-left:5px">${LABELS[m]}</span></button>`).join("")}
            </div>
            <p class="hint">Follows the system on first visit, then keeps your choice.</p>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Security</h2>
        <p>What this build actually does, and what it does not.</p>
        <div class="fieldgrid" style="margin-top:14px">
          <div><span class="flabel">Key derivation</span><span class="fvalue">${esc(state.meta.kdf || "scrypt")}</span></div>
          <div><span class="flabel">Vault key</span><span class="fvalue">Wrapped by the password key</span></div>
          <div><span class="flabel">Item values</span><span class="fvalue">Encrypted at rest</span></div>
          <div><span class="flabel">Search</span><span class="fvalue">Blind index</span></div>
        </div>
        <div class="error" style="margin-top:14px;color:var(--warn);border-color:var(--warn)">
          Not audited. The plan requires an independent cryptographic review before real secrets are stored.
        </div>
      </div>
      <div class="panel">
        <h2>Sync</h2>
        <p>Off by default. When it is on, your own machines exchange the records the
          vault already stores encrypted. The store cannot read them, and it keeps
          no plaintext.</p>
        <div data-sync-body style="margin-top:12px">
          <p class="hint">Checking…</p>
        </div>
        <h2 style="margin-top:22px">Conflicts</h2>
        <div data-sync-conflicts style="margin-top:10px"><p class="hint">Checking…</p></div>
        <div data-conflict-view></div>
        <p class="hint" style="margin-top:16px">A store token is a write credential. Anyone
          holding it can write junk into the store, though not read a secret. Rotating it
          cuts off the old device.</p>
      </div>
      <div class="panel">
        <h2>Export</h2>
        <p>Download a JSON copy of the decrypted vault. Store it somewhere you trust, or delete it immediately.</p>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn" type="button" data-export>${icons.download} Export JSON</button>
          <button class="btn btn--quiet" type="button" data-lock>${icons.lock} Lock now</button>
        </div>
      </div>
    </div>`,
  };
}

/* ---------------------------------------------------------------- shell */

const NAV = [
  ["vault", "Vault", "vault", "14"],
  ["import", "Imports", "upload", ""],
  ["activity", "Activity", "activity", ""],
  ["devices", "Devices", "device", ""],
  ["settings", "Settings", "gear", ""],
];

function render() {
  const view =
    state.view === "import" ? renderImport()
    : state.view === "activity" ? renderActivity()
    : state.view === "devices" ? renderDevices()  // loadDevices() runs after paint, below
    : state.view === "settings" ? renderSettings()  // loadSync() runs after paint too
    : renderVault();

  const count = state.items.length;
  const app = $("#app");
  app.innerHTML = `
    <a class="skip" href="#main">Skip to content</a>
    <div class="app">
      <nav class="rail" aria-label="Main">
        <div class="rail-brand">${mark(22)}<strong>Hasp</strong></div>
        <div class="rail-ws">${esc(state.meta.name || "Personal")}</div>
        <div class="rail-nav">
          ${NAV.map(
            ([key, label, icon, badge]) => `<a href="#${key}" data-view="${key}"${state.view === key ? ' aria-current="page"' : ""}>${icons[icon]}<span>${label}</span>${key === "vault" ? `<em>${count}</em>` : badge ? `<em>${badge}</em>` : ""}</a>`
          ).join("")}
        </div>
        <div class="rail-foot">
          <div class="rail-sync"><i class="dot${state.sync?.paired ? " is-live" : ""}"></i><span>${state.sync?.paired ? "Sync on" : "On this machine"}</span></div>
          <div class="rail-user">
            <span class="avatar">SR</span>
            <span><b>sarang@studio.dev</b><em>Sample vault</em></span>
          </div>
        </div>
      </nav>
      <main class="main" id="main">
        <header class="topbar">
          <div class="titleblock">
            <h1>${esc(view.title)}</h1>
            <p>${esc(view.sub)}</p>
          </div>
          <div class="topact">
            ${state.view === "vault" ? `<label class="search">${icons.search}<input type="search" placeholder="Search" value="${esc(state.query)}" aria-label="Search the vault" data-search><kbd>⌘K</kbd></label>` : ""}
            <button class="btn btn--primary" type="button" data-add>${icons.plus} Add item</button>
            <div class="switches"></div>
          </div>
        </header>
        ${view.filters}
        <div class="content${state.view === "vault" ? "" : " is-solo"}">${view.body}</div>
      </main>
    </div>
    <div class="toast" role="status" aria-live="polite"></div>`;
  renderSwitches();
  tickTotp();
  // The device list is fetched after the shell is in the document, so a slow or
  // refused request cannot stop the page from painting.
  if (state.view === "devices") loadDevices();
  if (state.view === "settings") loadSync();
  if (state.view === "activity") loadActivity();
}

/* ---------------------------------------------------------------- toast */

let toastTimer;
function toast(message, { sticky = false } = {}) {
  const el = $(".toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => el.classList.remove("is-on"), 2600);
}

/* ---------------------------------------------------------------- clipboard */

// The pending clipboard clear. Kept module-level so locking the vault can cancel
// it: a timer that fires after the session ends is a timer holding a secret in a
// closure for no reason, and clearing the clipboard of a *locked* vault would erase
// whatever the reader copied since, since this code cannot verify what is on the
// clipboard without permission.
let clipboardTimer = null;
let clipboardValue = null;

/** Cancel any pending clear. Called on lock and on unload. */
export function cancelClipboardClear() {
  if (clipboardTimer) clearTimeout(clipboardTimer);
  clipboardTimer = null;
  clipboardValue = null;
}

async function copyText(text, note) {
  try {
    await navigator.clipboard.writeText(text);
    toast(note || "Copied. Clipboard clears in 30 seconds.");
    // Best effort: clear it, as the plan asks. Only the most recent copy is
    // tracked, so copying twice does not leave the first timer running against
    // a value it can no longer check.
    cancelClipboardClear();
    clipboardValue = text;
    clipboardTimer = setTimeout(async () => {
      clipboardTimer = null;
      try {
        // Read back before clearing: if the reader has copied something else
        // since, leave it alone.
        const now = await navigator.clipboard.readText();
        if (now === clipboardValue) await navigator.clipboard.writeText("");
      } catch {
        // Reading the clipboard needs permission; failing is fine.
      }
      clipboardValue = null;
    }, 30000);
    return true;
  } catch {
    toast("This browser blocked the clipboard. Use Reveal and copy by hand.");
    return false;
  }
}

/* ---------------------------------------------------------------- totp tick */

/**
 * Roll the visible one-time code once a second, from the secret the server
 * already decrypted. Never a request; the code is a local calculation.
 *
 * If the page has no WebCrypto the code cannot be recomputed here, so the value
 * the server sent stands and the countdown still runs. A missing primitive must
 * not take the whole interface down with it.
 */
function tickTotp() {
  clearInterval(state.timer);
  const node = $("[data-totp]");
  if (!node) return;
  const secret = node.dataset.totp;
  const step = 30;

  async function update() {
    const remaining = step - (Math.floor(Date.now() / 1000) % step);
    try {
      const counter = Math.floor(Date.now() / 1000 / step);
      const code = await hotp(secret, counter, 6);
      node.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
      node.dataset.live = "1";
    } catch {
      if (node.dataset.live !== "1") node.dataset.live = "0";
    }
    const meter = $("[data-meter]");
    if (meter) meter.style.width = `${(remaining / step) * 100}%`;
    const countdown = $("[data-countdown]");
    if (countdown) countdown.textContent = `${remaining}s left`;
  }

  update();
  state.timer = setInterval(update, 1000);
}

/** HOTP in the page, so the code rolls without a request. Mirrors core/totp.js. */
async function hotp(secret, counter, digits) {
  if (!globalThis.crypto?.subtle) throw new Error("no WebCrypto in this browser");
  const key = base32Decode(secret);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, buf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).toUpperCase().replace(/[\s=]+/g, "");
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("bad base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* ---------------------------------------------------------------- actions */

async function load() {
  const data = await api("/api/state");
  state.items = data.items;
  state.meta = data.meta;
  if (!state.selectedId && data.items.length) state.selectedId = data.items[0].id;
  const hash = location.hash.replace("#", "");
  if (["vault", "import", "activity", "devices", "settings"].includes(hash)) state.view = hash;
}

async function refresh() {
  const before = state.selectedId;
  await load();
  if (before && !state.items.some((i) => i.id === before)) state.selectedId = state.items[0]?.id ?? null;
  render();
}

async function saveItem(payload, id) {
  if (id) await api(`/api/items/${id}`, { method: "PUT", body: JSON.stringify(payload) });
  else await api("/api/items", { method: "POST", body: JSON.stringify(payload) });
  await refresh();
}

function openEditor(item) {
  const editing = Boolean(item);
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <div class="modal-head">
        <div><h2 id="editor-title">${editing ? "Edit item" : "Add item"}</h2><p>${editing ? `Version ${item.version + 1} will be recorded.` : "Stored encrypted. The server keeps no plaintext."}</p></div>
        <button class="btn btn--small btn--quiet" type="button" data-close aria-label="Close">${icons.close}</button>
      </div>
      <form class="fieldset" novalidate>
        <div>
          <label class="label" for="f-name">Name</label>
          <input class="input" id="f-name" name="name" value="${esc(item?.name || "")}" placeholder="Groq production" required>
        </div>
        <div class="row-2">
          <div>
            <label class="label" for="f-type">Type</label>
            <select class="select" id="f-type" name="type">
              ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}"${item?.type === v ? " selected" : ""}>${l}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="label" for="f-env">Environment</label>
            <select class="select" id="f-env" name="env">
              ${["", "prod", "staging", "live", "dev"].map((v) => `<option value="${v}"${(item?.env ?? "") === v ? " selected" : ""}>${ENV_LABEL[v]}</option>`).join("")}
            </select>
          </div>
        </div>
        <div>
          <label class="label" for="f-value">Secret</label>
          <textarea class="textarea" id="f-value" name="value" placeholder="gsk_prod_...">${esc(item?.value || "")}</textarea>
        </div>
        <div>
          <label class="label" for="f-host">Service host</label>
          <input class="input" id="f-host" name="host" value="${esc(item?.host || "")}" placeholder="console.groq.com">
        </div>
        <div>
          <label class="label" for="f-notes">Notes</label>
          <textarea class="textarea" id="f-notes" name="notes" placeholder="Rotation reminder, owner, anything the key needs to stay meaningful.">${esc(item?.notes || "")}</textarea>
        </div>
        <p class="error" data-error hidden></p>
        <div class="modal-foot">
          <button class="btn btn--quiet" type="button" data-close>Cancel</button>
          <button class="btn btn--primary" type="submit">${editing ? "Save changes" : "Add to vault"}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);
  const form = $("form", wrap);
  // Remember what opened the dialog so focus can go back to it. Without this a
  // keyboard user is dropped at the top of the document when the dialog closes,
  // which is disorienting in a list that may be hundreds of rows long.
  const opener = document.activeElement;
  document.body.classList.add("is-modal-open");
  $("input", form).focus();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.body.classList.remove("is-modal-open");
    // The opener can be gone if the row was deleted while the dialog was open.
    if (opener && document.contains(opener) && typeof opener.focus === "function") opener.focus();
  };
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-close]")) close();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (e.key === "Tab") trapFocus(e, wrap);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name.trim()) return showError("Give the item a name.");
    if (data.type === "api-key" && !data.value.trim()) return showError("An API key needs a value.");
    if (data.type === "totp") return showError("One-time code items are added from a file or paste, so the secret can be checked.");
    try {
      await saveItem(data, item?.id);
      close();
      toast(editing ? "Item updated" : "Item added");
    } catch (err) {
      showError(err.message);
    }
  });
}

function showError(message) {
  const el = $("[data-error]");
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
}

function trapFocus(e, root) {
  const focusable = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', root).filter(
    (el) => !el.disabled && el.offsetParent !== null
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* ---------------------------------------------------------------- events */

document.addEventListener("click", async (e) => {
  const t = e.target;

  const dirSwitch = t.closest("[data-dir-switch]");
  if (dirSwitch) return setAppearance({ dir: dirSwitch.dataset.dirSwitch, mode: currentAppearance().mode });

  const modeSwitch = t.closest("[data-mode-switch]");
  if (modeSwitch) return setAppearance({ dir: currentAppearance().dir, mode: modeSwitch.dataset.modeSwitch });

  const navLink = t.closest("[data-view]");
  if (navLink) {
    e.preventDefault();
    state.view = navLink.dataset.view;
    history.replaceState(null, "", `#${state.view}`);
    clearInterval(state.timer);
    render();
    return;
  }

  const row = t.closest(".row[data-id]");
  if (row) {
    state.selectedId = row.dataset.id;
    state.revealUntil = 0;
    return render();
  }

  const typeChip = t.closest("[data-type]");
  if (typeChip) {
    state.type = typeChip.dataset.type;
    return render();
  }

  if (t.closest("[data-env-cycle]")) {
    const order = ["all", "prod", "live", "staging", "dev", ""];
    state.env = order[(order.indexOf(state.env) + 1) % order.length];
    return render();
  }

  const restore = t.closest("[data-restore]");
  if (restore) {
    try {
      await api(`/api/items/${restore.dataset.restore}?restore=1`, { method: "POST" });
      await refresh();
      state.deleted = null;
      await loadActivity();
      toast("Item restored");
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (t.closest("[data-add]")) return openEditor(null);

  const editBtn = t.closest("[data-edit]");
  if (editBtn) {
    const item = state.items.find((i) => i.id === state.selectedId);
    if (item) openEditor(item);
    return;
  }

  if (t.closest("[data-delete]")) {
    const item = state.items.find((i) => i.id === state.selectedId);
    if (!item) return;
    if (!confirm(`Delete "${item.name}"? It stays in the vault and can be restored from Activity.`)) return;
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    state.selectedId = null;
    await refresh();
    return toast("Item deleted");
  }

  if (t.closest("[data-copy]")) {
    const item = state.items.find((i) => i.id === state.selectedId);
    if (!item) return;
    if (await copyText(item.value)) {
      await api(`/api/items/${item.id}/touch`, { method: "POST" }).catch(() => {});
      state.items = state.items.map((i) => (i.id === item.id ? { ...i, lastUsedAt: new Date().toISOString() } : i));
      render();
    }
    return;
  }

  if (t.closest("[data-reveal]")) {
    state.revealUntil = state.revealUntil > Date.now() ? 0 : Date.now() + 30000;
    return render();
  }

  if (t.closest("[data-copy-totp]")) {
    const code = $("[data-totp]")?.textContent?.replace(/\s/g, "");
    return copyText(code, "Code copied.");
  }

  const copyCode = t.closest("[data-copy-code]");
  if (copyCode) {
    const rowEl = copyCode.closest(".code-row");
    return copyText(rowEl.dataset.code, "One backup code copied.");
  }

  const spendCode = t.closest("[data-spend-code]");
  if (spendCode) {
    const item = state.items.find((i) => i.id === state.selectedId);
    const index = Number(spendCode.dataset.spendCode);
    const codes = item.codes.map((c, n) => (n === index ? { ...c, usedAt: new Date().toISOString() } : c));
    await saveItem({ ...item, codes }, item.id);
    return toast("Marked as used");
  }

  if (t.closest("[data-export]")) return exportVault();

  const accentSwitch = t.closest("[data-accent-switch]");
  if (accentSwitch) {
    const { dir, mode } = currentAppearance();
    choose(store, { dir, mode, accent: accentSwitch.dataset.accentSwitch });
    return applyAppearance({ dir, mode, accent: accentSwitch.dataset.accentSwitch });
  }

  /* ---- sync */

  if (t.closest("[data-sync-start]")) {
    try {
      const started = await api("/api/sync/start", { method: "POST" });
      // The token is shown once here because the store keeps only a hash. It is held
      // in memory and never written to storage, so a reload hides it for good.
      state.syncToken = started.token;
      state.sync = await api("/api/sync/status");
      renderSyncBody();
      toast("Sync is on. Copy the write token.");
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (t.closest("[data-sync-rotate]")) {
    // Forgetting the pairing then starting again mints a new token. The old one is
    // dead the moment the store replaces its hash.
    try {
      await api("/api/sync/pairing", { method: "DELETE" });
      const started = await api("/api/sync/start", { method: "POST" });
      state.syncToken = started.token;
      state.sync = await api("/api/sync/status");
      renderSyncBody();
      toast("New token. The old one no longer works.");
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (t.closest("[data-sync-off]")) {
    try {
      await api("/api/sync/pairing", { method: "DELETE" });
      state.syncToken = null;
      state.sync = await api("/api/sync/status");
      renderSyncBody();
      toast("Sync is off. The stored copy is still on the other side.");
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (t.closest("[data-sync-round]")) {
    try {
      const round = await api("/api/sync/round", { method: "POST", body: JSON.stringify({ since: 0 }) });
      state.sync = await api("/api/sync/status");
      renderSyncBody();
      if (round.conflicts.length) {
        toast(`${round.conflicts.length} item changed on both machines. Nothing was overwritten.`);
      } else if (!round.pulled.applied && !round.pushed) {
        toast("Already up to date.");
      } else {
        toast(`${round.pulled.applied} in, ${round.pushed} out.`);
      }
      // A round changes rows, so the list behind the panel is stale.
      await load();
      if (state.view === "settings") render();
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  /* ---- conflict resolution */

  const openConflict = t.closest("[data-conflict-open]");
  if (openConflict) {
    const id = openConflict.dataset.conflictOpen;
    // Clear the old view first, or a slow reply for one item would land on top of
    // another one that was opened after it.
    state.conflictView = null;
    renderConflictView();
    const view = $("[data-conflict-view]");
    if (view) view.innerHTML = `<p class="hint">Opening both copies…</p>`;
    try {
      state.conflictView = await api(`/api/sync/conflicts/compare?id=${encodeURIComponent(id)}`);
    } catch (err) {
      state.conflictView = { error: err.message, id };
    }
    renderConflictView();
    return;
  }

  if (t.closest("[data-conflict-close]")) {
    state.conflictView = null;
    renderConflictView();
    return;
  }

  const keep = t.closest("[data-conflict-keep]");
  if (keep) {
    const id = state.conflictView?.id;
    if (!id) return;
    try {
      const result = await api("/api/sync/conflicts/resolve", {
        method: "POST",
        body: JSON.stringify({ id, keep: keep.dataset.conflictKeep }),
      });
      state.conflictView = null;
      state.conflicts = (await api("/api/sync/conflicts")).conflicts;
      state.sync = await api("/api/sync/status");
      await load();
      if (state.view === "settings") render();
      toast(result.kept === "local" ? "Kept this machine's copy." : "Took the other machine's copy.");
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  if (t.closest("[data-tour-start]")) return startTour();

  if (t.closest("[data-lock]")) {
    cancelClipboardClear();
    await api("/api/lock", { method: "POST" });
    return location.reload();
  }

  const drop = t.closest(".drop");
  if (drop) return $("input[type=file]", drop)?.click();

  if (t.closest("[data-parse-paste]")) return parsePaste();
  if (t.closest("[data-pair-start]")) return startPairing();
  if (t.closest("[data-pair-revoke]")) return revokeDevice(t.closest("[data-pair-revoke]").dataset.pairRevoke);
});

document.addEventListener("input", (e) => {
  if (!e.target.matches("[data-search]")) return;
  state.query = e.target.value;
  // The search field is not inside .content, so replacing the list below does not
  // touch the caret. That is why this handler no longer has to be careful about it.
  searchNow(state.query);
});

document.addEventListener("change", async (e) => {
  if (e.target.matches('.drop input[type="file"]')) {
    const file = e.target.files?.[0];
    if (file) await importFile(file);
  }
});

document.addEventListener("dragover", (e) => {
  const drop = e.target.closest(".drop");
  if (!drop) return;
  e.preventDefault();
  drop.classList.add("is-over");
});

document.addEventListener("dragleave", (e) => {
  e.target.closest(".drop")?.classList.remove("is-over");
});

document.addEventListener("drop", async (e) => {
  const drop = e.target.closest(".drop");
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove("is-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) await importFile(file);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("[data-search]")?.focus();
  }
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("[data-search]")?.focus();
  }
});

/* ---------------------------------------------------------------- import */

async function importFile(file) {
  if (file.size > 8 * 1024 * 1024) return toast("That file is over 8 MB. Export a smaller range.");
  const text = await file.text();
  await runImport(text, file.name);
}

/**
 * Show a pairing code for a phone.
 *
 * The code is a secret. It is drawn once, on this screen, and the panel says not to
 * leave it visible: anyone who photographs it can pair a device that reads codes
 * until it is revoked below.
 */
async function startPairing() {
  const body = $("#pair-body");
  if (!body) return;
  body.innerHTML = `<p class="hint">Generating a code.</p>`;
  try {
    const data = await api("/api/pair/start", { method: "POST", body: JSON.stringify({}) });
    body.innerHTML = `<div class="codebox">
      <span class="flabel">Pairing code, valid for ${Math.round(data.expiresIn / 60)} minute${data.expiresIn >= 120 ? "s" : ""}</span>
      <output class="paircode" aria-label="Pairing code">${esc(data.code)}</output>
      <p class="hint">On the phone, open Hasp, enter this machine's address and this code. Do not leave it on screen.</p>
      <button class="btn btn--quiet" type="button" data-pair-start>Hide the code</button>
    </div>`;
    const button = body.querySelector("[data-pair-start]");
    if (button) button.textContent = "Hide the code";
    // Hide it if the panel is left open. A code on an unattended screen is the
    // whole risk.
    setTimeout(() => {
      const stillThere = $("#pair-body .paircode");
      if (stillThere) stillThere.closest(".codebox")?.remove();
    }, 120000);
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

/** The paired devices, and the button that revokes one. */
async function loadDevices() {
  const list = $("#pair-devices");
  if (!list) return;
  try {
    const data = await api("/api/pair/devices");
    const devices = data.devices || [];
    list.innerHTML = devices.length
      ? `<ul class="notes">${devices
          .map(
            (d) => `<li class="note is-on"><span class="note-meta">Paired ${esc(new Date(d.pairedAt).toLocaleDateString())}</span>
              <p>${esc(d.label)}</p>
              <button class="btn btn--quiet" type="button" data-pair-revoke="${esc(d.id)}">Revoke</button></li>`,
          )
          .join("")}</ul>
        <p class="hint">Revoking takes effect at once. A revoked phone is told to pair again.</p>`
      : `<p class="hint">No phone is paired. A paired phone can read the current one-time codes and nothing else.</p>`;
  } catch (err) {
    list.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function revokeDevice(id) {
  if (!id) return;
  try {
    await api(`/api/pair/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Device revoked");
    await loadDevices();
  } catch (err) {
    toast(err.message);
  }
}

async function parsePaste() {
  const text = $("#paste")?.value || "";
  if (!text.trim()) return toast("Paste something first.");
  await runImport(text, "pasted text");
}

async function runImport(text, name) {
  const result = $("#import-result");
  if (result) result.innerHTML = `<div class="panel"><p>Reading ${esc(name)}…</p></div>`;
  try {
    const data = await api("/api/import/parse", { method: "POST", body: JSON.stringify({ text, filename: name }) });
    if (result) result.innerHTML = renderReview(data.candidates, data.source, data.duplicates || []);
    toast(`${data.candidates.length} candidates read from ${data.source}`);
  } catch (err) {
    if (result) result.innerHTML = `<div class="panel"><p class="error">${esc(err.message)}</p></div>`;
  }
}

function renderReview(candidates, source, duplicates) {
  // A parse that recognises the file but finds nothing in it is a real outcome: a
  // truncated export, or a vault with no codes in it. Dividing by zero here
  // rendered NaN% and an empty panel, so it is a message instead.
  if (!candidates.length) {
    return `<div class="panel">
      <h2>Nothing to import</h2>
      <p>${source ? `${esc(source)} was read, but it holds no entries that can be stored.` : "That file was not recognised."}</p>
      <p>Supported: Google Keep JSON and HTML, password manager CSV, otpauth links, and the JSON exports of six authenticator apps.</p>
    </div>`;
  }
  const accepted = candidates.filter((c) => !c.needsReview && !duplicates.includes(c.id)).length;
  return `<div class="panel">
    <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:6px">
      <div style="flex:1"><h2>Import review</h2><p>${esc(source)}, ${candidates.length} candidates, ${accepted} ready to accept.</p></div>
      ${duplicates.length ? `<span class="chip chip--warn">${duplicates.length} duplicates</span>` : ""}
    </div>
    <div class="progress" aria-hidden="true"><i style="width:${Math.round((accepted / candidates.length) * 100)}%"></i></div>
    </div>
    <div class="panel">
      <div class="review">
        <div>
          <span class="flabel">Candidates</span>
          <ul class="notes">
            ${candidates
              .map(
                (c, n) => `<li class="note${n === 0 ? " is-on" : ""}" data-candidate="${esc(c.id)}">
                <span class="note-meta">${esc(c.type)}${c.env ? `, ${esc(c.env)}` : ""}${duplicates.includes(c.id) ? ", duplicate" : ""}</span>
                <p>${esc(c.name)}</p>
                <span class="note-match">${esc(c.service || c.host || "unrecognised")}${c.needsReview ? " · needs review" : ""}</span>
              </li>`
              )
              .join("")}
          </ul>
        </div>
        <div>
          <span class="flabel">Parsed fields</span>
          <div class="pv-fields">
            ${candidates
              .slice(0, 1)
              .map(
                (c) => `
              <div class="pv-row"><span>Name</span><span class="pv-val">${esc(c.name)}</span><span class="conf ${c.confidence.name < 0.7 ? "is-low" : ""}">${pct(c.confidence.name)}</span></div>
              <div class="pv-row"><span>Service</span><span class="pv-val">${esc(c.service || c.host || "—")}</span><span class="conf ${(c.confidence.service ?? 1) < 0.7 ? "is-low" : ""}">${pct(c.confidence.service ?? 1)}</span></div>
              <div class="pv-row"><span>Type</span><span class="pv-val">${esc(TYPE_LABEL[c.type] || c.type)}</span><span class="conf ${(c.confidence.type ?? 1) < 0.7 ? "is-low" : ""}">${pct(c.confidence.type ?? 1)}</span></div>
              <div class="pv-row"><span>Environment</span><span class="pv-val">${ENV_LABEL[c.env] || "not labelled"}</span><span class="conf ${(c.confidence.env ?? 1) < 0.7 ? "is-low" : ""}">${pct(c.confidence.env ?? 1)}</span></div>
              <div class="pv-row"><span>Value</span><span class="pv-val mono">${esc(mask(c.value || c.totp?.secret || ""))}</span><span class="conf ${(c.confidence.value ?? 1) < 0.7 ? "is-low" : ""}">${pct(c.confidence.value ?? 1)}</span></div>`
              )
              .join("")}
          </div>
          <p class="hint">Anything under 70 percent stays in review. Nothing is stored until you accept.</p>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="btn btn--primary" type="button" data-accept="${esc(candidates[0].id)}">Accept all ${accepted}</button>
            <button class="btn btn--quiet" type="button" data-discard>Discard</button>
          </div>
        </div>
      </div>
    </div>`;
}

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

function mask(value) {
  if (!value) return "—";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 6)}${"•".repeat(8)}`;
}

document.addEventListener("click", async (e) => {
  const accept = e.target.closest("[data-accept]");
  if (accept) {
    const btn = accept;
    btn.disabled = true;
    try {
      const data = await api("/api/import/accept", { method: "POST", body: JSON.stringify({ acceptAll: true }) });
      toast(`${data.added} items added${data.skipped ? `, ${data.skipped} duplicates skipped` : ""}`);
      state.view = "vault";
      history.replaceState(null, "", "#vault");
      await refresh();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
    return;
  }
  if (e.target.closest("[data-discard]")) {
    const host = $("#import-result");
    if (host) host.innerHTML = "";
    return toast("Nothing was stored.");
  }
});

/* ---------------------------------------------------------------- export */

async function exportVault() {
  const data = await api("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hasp-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Export downloaded. Delete it once you have it somewhere safe.");
}

/* ---------------------------------------------------------------- gate */

/**
 * The unlock screen. The vault key is only created by a successful unwrap, so
 * this screen is the real thing rather than a mock. The sample password is
 * printed because this is a sample vault: the plan's rule is that a sample
 * build must say so, not that it must hide its own fixtures.
 */
/**
 * Disable the gate form for `seconds`, counting down in the button. Shared by the
 * render path and by a throttle response, so a reload during a wait still counts
 * rather than offering a fresh form.
 */
export function lockGateUntil(form, seconds) {
  const btn = $('button[type="submit"]', form);
  const input = $("input", form);
  if (!btn || !input) return;
  let left = Math.ceil(seconds);
  btn.disabled = true;
  input.disabled = true;
  const paint = () => {
    btn.textContent = `Wait ${left}s`;
    if (left <= 0) {
      btn.disabled = false;
      input.disabled = false;
      btn.textContent = "Unlock";
      input.focus();
      return;
    }
    left -= 1;
    setTimeout(paint, 1000);
  };
  paint();
  return () => {
    btn.disabled = false;
    input.disabled = false;
    btn.textContent = "Unlock";
  };
}

function renderGate({ samplePassword, error, wait = 0 }) {
  const app = $("#app");
  app.innerHTML = `<div class="gate">
    <div class="gate-card">
      <div class="gate-mark">${mark(22)}<strong>Hasp</strong></div>
      <h1>Unlock the vault</h1>
      <p class="sub">The master password never leaves this process. It derives the key that opens the vault, and the key is dropped when the session ends.</p>
      <form class="fieldset">
        <div>
          <label class="label" for="master">Master password</label>
          <input class="input" id="master" name="password" type="password" autocomplete="current-password" value="${esc(samplePassword || "")}" required>
        </div>
        ${error ? `<p class="error">${esc(error)}</p>` : ""}
        <button class="btn btn--primary" type="submit" style="justify-content:center" data-unlock>${icons.unlock} Unlock</button>
      </form>
      ${
        samplePassword
          ? `<div class="why" style="margin-top:18px;border-top:1px solid var(--line-2);padding-top:14px">
               <span class="flabel">Sample vault</span>
               <p style="font-size:12px;color:var(--ink-2)">This build ships with invented items so the interface can be judged. The password is
               <code style="color:var(--accent)">${esc(samplePassword)}</code> and it is filled in for you. Nothing here is a real secret.</p>
             </div>`
          : ""
      }
      <p class="hint" style="margin-top:14px">Idle lock after ${Math.round((state.meta.idleMs || 300000) / 60000)} minutes.</p>
    </div>
  </div>`;

  const form = $("form", app);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      await api("/api/unlock", { method: "POST", body: JSON.stringify({ password: $("#master").value }) });
      await start();
    } catch (err) {
      renderGate({ samplePassword, error: err.message, wait: err.retryAfter || 0 });
    }
  });

  // A throttle is a countdown, so show one. Leaving the button live invites a
  // click that is guaranteed to fail and a second error that says the same thing.
  if (wait > 0) lockGateUntil(form, wait);
}

/* ---------------------------------------------------------------- boot */

async function start() {
  await load();
  render();

  // A first visit gets the walkthrough. It is skippable from the first step, and
  // skipping is remembered, so it never becomes something to click through twice.
  try {
    if (!localStorage.getItem("hasp.tour") && !location.hash.includes("notour")) setTimeout(() => startTour(), 400);
  } catch {
    // Storage blocked: show it, since there is no way to remember a skip.
    setTimeout(() => startTour(), 400);
  }
  window.addEventListener("hashchange", () => {
    const hash = location.hash.replace("#", "");
    if (["vault", "import", "activity", "devices", "settings"].includes(hash) && hash !== state.view) {
      state.view = hash;
      clearInterval(state.timer);
      render();
    }
  });
}

/* -------------------------------------------------------------------- tour */

let tour = null;

/**
 * Start the guided walkthrough. Declared as a function rather than a const so the
 * click handler defined earlier can call it: the bundled copy the UI tests load has
 * the `export` keyword removed, and only function declarations hoist.
 */
function startTour() {
  if (tour && !tour.done) return tour;
  tour = buildTour({ onTourFinish: () => {} });
  tour.start();
  return tour;
}

/* ------------------------------------------------------------- idle warning */

// The server drops a session after an idle period, and until now the client found
// out by being reloaded mid-action, losing whatever was typed. This warns a minute
// before that happens, and gives one action that keeps the session alive.
//
// It is a courtesy, not a security control: the server decides, always. The timer
// here only decides when to say something.

let idleTimer = null;

/** Milliseconds until the session lapses, from the last request this page made. */
function scheduleIdleWarning(idleMs) {
  clearTimeout(idleTimer);
  if (!idleMs) return;
  const warnAt = Math.max(idleMs - 60_000, 0);
  idleTimer = setTimeout(() => toast("Still there? This vault locks in a minute.", { sticky: true }), warnAt);
}

export function cancelIdleWarning() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

export async function boot() {
  const initial = resolve(store, { prefersDark: matchMedia("(prefers-color-scheme: dark)").matches });
  applyAppearance({ dir: initial.dir, mode: initial.mode, accent: initial.accent });

  const session = await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json());
  state.meta = { ...(session.meta || {}), idleMs: session.idleMs };

  if (!session.unlocked) {
    renderGate({ samplePassword: session.samplePassword, error: "" });
    return;
  }
  await start();
  scheduleIdleWarning(state.meta.idleMs);
}

export { state, render, refresh, hotp, base32Decode, startTour };
