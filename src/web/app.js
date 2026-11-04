// The application. Renders the vault from the server's decrypted view, keeps the
// selection and filters in the URL hash so a refresh lands where you were, and
// hands every mutation back to the server.
//
// The server sends values to this page because the page is the vault. The plan's
// rule is that plaintext never reaches the *server's* storage, and it does not:
// what arrives here was decrypted in the request that produced it.

import { resolve, choose, attributes, DIRECTIONS, MODES, LABELS, NOTES } from "./appearance.js";
import { icons, mark, brandMark } from "./icons.js";

/* ---------------------------------------------------------------- state */

const state = {
  view: "vault", // vault | import | activity | devices | settings
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
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
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
  for (const [k, v] of Object.entries(attributes(next))) root.setAttribute(k, v);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = next.mode === "dark" ? "#14140f" : "#e8e6e0";
  renderSwitches();
}

function currentAppearance() {
  const root = document.documentElement;
  return { dir: root.dataset.dir, mode: root.dataset.mode };
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

function tileFor(item) {
  if (item.brand) {
    return `<span class="tile">${brandMark(item.brand, "")}</span>`;
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

function visible() {
  const q = state.query.trim().toLowerCase();
  return state.items.filter((i) => {
    if (state.type !== "all" && i.type !== state.type) return false;
    if (state.env !== "all" && (i.env || "") !== state.env) return false;
    if (!q) return true;
    return `${i.name} ${i.service} ${i.host} ${i.type} ${i.tags?.join(" ") || ""}`.toLowerCase().includes(q);
  });
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
        <p>Google Keep Takeout, one-time code exports and password manager CSV. Every parsed field carries a confidence score, and anything under 70 percent goes to review before it is stored.</p>
        <div class="drop" tabindex="0" role="button" aria-label="Choose a file to import">
          ${icons.upload}
          <strong>Drop a file, or choose one</strong>
          <span>Keep .json, Keep .html, .txt with otpauth links, or .csv</span>
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
  const events = state.items
    .slice()
    .sort((a, b) => (b.lastUsedAt || "").localeCompare(a.lastUsedAt || ""))
    .slice(0, 12);
  return {
    title: "Activity",
    sub: "Recent use across this vault",
    filters: "",
    body: `<div class="page"><div class="panel">
      <h2>Recent activity</h2>
      <p>Every copy, fill and rotation is recorded here. Item values never appear in the log.</p>
      <div class="activity" style="border-top:none;padding-top:14px">
        <ul>
          ${events
            .map(
              (i) => `<li><span>${esc(i.name)} copied</span><span>${relTime(i.lastUsedAt)}</span></li>`
            )
            .join("")}
        </ul>
      </div>
    </div></div>`,
  };
}

function renderDevices() {
  return {
    title: "Devices",
    sub: "Where this vault is unlocked",
    filters: "",
    body: `<div class="page"><div class="panel">
      <h2>Devices</h2>
      <p>The vault key is held in memory on the server for the length of a session. Closing the session drops it.</p>
      <div class="fieldgrid" style="margin-top:16px">
        <div><span class="flabel">This browser</span><span class="fvalue">Active session</span></div>
        <div><span class="flabel">Idle lock</span><span class="fvalue">${Math.round((state.meta.idleMs || 300000) / 60000)} minutes</span></div>
        <div><span class="flabel">Web</span><span class="fvalue">Not built</span></div>
        <div><span class="flabel">Extension</span><span class="fvalue">Not built</span></div>
      </div>
      <p class="hint">Device records, revocation and the extension unlock flow are phase 2 work. This page says so rather than showing invented devices.</p>
    </div></div>`,
  };
}

function renderSettings() {
  const { dir, mode } = currentAppearance();
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
    : state.view === "devices" ? renderDevices()
    : state.view === "settings" ? renderSettings()
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
          <div class="rail-sync"><i class="dot"></i><span>Synced locally</span></div>
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
  $("input", form).focus();

  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-close]")) close();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
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
    if (!confirm(`Delete "${item.name}"? It can be restored from the vault data.`)) return;
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

  if (t.closest("[data-lock]")) {
    cancelClipboardClear();
    await api("/api/lock", { method: "POST" });
    return location.reload();
  }

  const drop = t.closest(".drop");
  if (drop) return $("input[type=file]", drop)?.click();

  if (t.closest("[data-parse-paste]")) return parsePaste();
});

document.addEventListener("input", (e) => {
  if (!e.target.matches("[data-search]")) return;
  state.query = e.target.value;

  // Replace only the list and the inspector, so the caret stays in the field.
  const content = $(".content");
  if (!content) return;
  const visibleIds = new Set(visible().map((i) => i.id));
  if (!visibleIds.has(state.selectedId)) {
    state.selectedId = visible().at(0)?.id ?? null;
    state.revealUntil = 0;
  }
  const { body } = renderVault();
  content.innerHTML = body;
  if (!state.selectedId) {
    const inspector = $(".inspector");
    if (inspector) inspector.outerHTML = `<aside class="inspector" aria-label="Item detail"><div class="empty"><strong>No match</strong>Nothing in the vault matches "${esc(state.query)}".</div></aside>`;
  }
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
function renderGate({ samplePassword, error }) {
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
        <button class="btn btn--primary" type="submit" style="justify-content:center">${icons.unlock} Unlock</button>
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
      btn.disabled = false;
      renderGate({ samplePassword, error: err.message });
    }
  });
}

/* ---------------------------------------------------------------- boot */

async function start() {
  await load();
  render();
  window.addEventListener("hashchange", () => {
    const hash = location.hash.replace("#", "");
    if (["vault", "import", "activity", "devices", "settings"].includes(hash) && hash !== state.view) {
      state.view = hash;
      clearInterval(state.timer);
      render();
    }
  });
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
  applyAppearance({ dir: initial.dir, mode: initial.mode });

  const session = await fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json());
  state.meta = { ...(session.meta || {}), idleMs: session.idleMs };

  if (!session.unlocked) {
    renderGate({ samplePassword: session.samplePassword, error: "" });
    return;
  }
  await start();
  scheduleIdleWarning(state.meta.idleMs);
}

export { state, render, refresh, hotp, base32Decode };
