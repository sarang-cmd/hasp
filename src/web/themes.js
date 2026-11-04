// Render the four surfaces from the same markup the product uses.
//
// The point of this page is that nothing here is a special case: each frame is
// a container carrying data-dir and data-mode, and the components are the real
// classes from app.css. If a frame looks wrong, the product looks wrong.

import { icons, mark, brandMark } from "./icons.js";

const ROWS = [
  ["groq", "Groq production", "console.groq.com", "prod", "2 hours ago", true, "api-key"],
  ["groq", "Groq staging", "console.groq.com", "staging", "6 days ago", false, "api-key"],
  ["stripe", "Stripe secret key", "dashboard.stripe.com", "live", "Yesterday", false, "api-key"],
  ["github", "GitHub token, deploys", "github.com", "prod", "4 days ago", false, "api-key"],
  ["neon", "Neon connection string", "console.neon.tech", "prod", "3 hours ago", false, "api-key"],
  ["cloudflare", "Cloudflare R2 token", "dash.cloudflare.com", "prod", "Last week", false, "api-key"],
  ["github", "GitHub recovery codes", "github.com", "", "Never used", false, "Backup codes"],
];

const ENV_GLYPH = { prod: "\u25B2", live: "\u25B2", staging: "\u25C6" };
const ENV_LABEL = { prod: "prod", live: "live", staging: "staging" };

function tag(env) {
  if (!env) return `<span class="tag tag--none">no env</span>`;
  return `<span class="tag tag--${env}"><i aria-hidden="true">${ENV_GLYPH[env]}</i>${ENV_LABEL[env]}</span>`;
}

function rail() {
  return `<nav class="rail" aria-label="Main">
    <div class="rail-brand">${mark(20)}<strong>Hasp</strong></div>
    <div class="rail-ws">Sarang, personal</div>
    <div class="rail-nav">
      <a href="#vault" aria-current="page">${icons.vault}<span>Vault</span><em>14</em></a>
      <a href="#imports">${icons.upload}<span>Imports</span></a>
      <a href="#activity">${icons.activity}<span>Activity</span></a>
      <a href="#devices">${icons.device}<span>Devices</span></a>
      <a href="#settings">${icons.gear}<span>Settings</span></a>
    </div>
    <div class="rail-foot">
      <div class="rail-sync"><i class="dot"></i><span>Synced locally</span></div>
      <div class="rail-user"><span class="avatar">SR</span><span><b>sarang@studio.dev</b><em>Sample vault</em></span></div>
    </div>
  </nav>`;
}

function tile(brand) {
  return `<span class="tile">${brandMark(brand, "")}</span>`;
}

function rows(selected = 0) {
  return ROWS.map(
    ([brand, name, host, env, when, on], n) => `<div class="row"${n === selected ? ' aria-selected="true"' : ""}>
      <span class="row-main">${tile(brand)}<span><span class="row-name">${name}</span><span class="row-sub">${host}</span></span></span>
      ${tag(env)}
      <span class="rwhen">${when}</span>
    </div>`
  ).join("");
}

function inspector({ totp = false } = {}) {
  return `<aside class="inspector" aria-label="Item detail">
    <div class="insp-head">${tile("groq")}<div><h2>Groq production</h2><p>API key, console.groq.com</p></div></div>
    ${
      totp
        ? `<div class="totp-card">
             <span class="flabel">One-time code</span>
             <div class="totp-code">428 109</div>
             <div class="meter"><i style="width:62%"></i></div>
             <div class="totp-meta"><span>19s left</span><span>GitHub</span></div>
           </div>`
        : `<div class="field">
             <span class="flabel">Secret</span>
             <div class="secret"><code>gsk_prod_7f2a<em>••••••••</em>9c41</code>
               <button class="btn btn--small" type="button">${icons.copy} Copy</button>
               <button class="btn btn--small btn--quiet" type="button">Reveal</button>
             </div>
             <p class="hint">Clipboard clears after 30 seconds.</p>
           </div>`
    }
    <div class="fieldgrid">
      <div><span class="flabel">Environment</span>${tag("prod")}</div>
      <div><span class="flabel">Updated</span><span class="fvalue">12 August</span></div>
    </div>
    <div class="why">
      <span class="flabel">Why Hasp suggests this</span>
      <p>Host matches console.groq.com. Label reads prod. Last use was 2 hours ago.</p>
    </div>
    <div class="activity">
      <span class="flabel">Activity</span>
      <ul>
        <li><span>Copied in Chrome</span><span>2h</span></li>
        <li><span>Filled on console.groq.com</span><span>1d</span></li>
      </ul>
    </div>
    <div class="insp-foot">
      <button class="btn btn--small btn--quiet" type="button">Rotate</button>
      <button class="btn btn--small btn--quiet" type="button">Edit</button>
    </div>
  </aside>`;
}

function mini(totp = false) {
  return `<div class="mini">
    ${rail()}
    <div class="main">
      <header class="topbar">
        <div class="titleblock"><h1>Vault</h1><p>14 items, 6 services, 2 devices</p></div>
        <div class="topact">
          <label class="search">${icons.search}<input type="text" placeholder="Search" aria-label="Search" readonly><kbd>⌘K</kbd></label>
          <button class="btn btn--primary" type="button">${icons.plus} Add item</button>
        </div>
      </header>
      <div class="filters">
        <span class="chip" aria-pressed="true">All <b>14</b></span>
        <span class="chip">API keys <b>9</b></span>
        <span class="chip">Backup codes <b>2</b></span>
        <span class="chip chip--end">Environment, all</span>
      </div>
      <div class="mini-side">
        <section class="list">
          <div class="list-head"><span>Item</span><span>Environment</span><span>Last used</span></div>
          ${rows(0)}
        </section>
        ${inspector({ totp })}
      </div>
    </div>
  </div>`;
}

/** The parts where a direction's construction is most visible. */
function parts() {
  return `<div class="parts">
    <span class="parts-label">Controls</span>
    <button class="btn btn--primary" type="button">${icons.plus} Add item</button>
    <button class="btn" type="button">${icons.copy} Copy</button>
    <button class="btn btn--quiet" type="button">Reveal</button>
    <span class="chip" aria-pressed="true">All <b>14</b></span>
    <span class="chip">API keys <b>9</b></span>
    ${tag("prod")} ${tag("staging")} ${tag("")}
    <span class="tag tag--dev">dev</span>
  </div>
  <div class="parts">
    <span class="parts-label">Field and code</span>
    <div style="flex:1;min-width:200px">
      <span class="flabel">Secret</span>
      <div class="secret"><code>gsk_prod_7f2a<em>••••••••</em>9c41</code></div>
    </div>
    <div style="min-width:150px">
      <span class="flabel">One-time code</span>
      <div class="totp-card" style="padding:10px 12px">
        <div class="totp-code" style="font-size:19px">428 109</div>
        <div class="meter"><i style="width:62%"></i></div>
      </div>
    </div>
    <div style="min-width:130px">
      <span class="flabel">Search</span>
      <label class="search" style="min-width:0">${icons.search}<input type="text" placeholder="Search" readonly></label>
    </div>
  </div>
  <div class="parts">
    <span class="parts-label">Switches</span>
    <div class="seg" role="group" aria-label="Direction demo">
      <button type="button" aria-pressed="true">Foundry</button>
      <button type="button">Nightshift</button>
    </div>
    <div class="seg" role="group" aria-label="Mode demo">
      <button type="button" aria-pressed="true">${icons.sun}</button>
      <button type="button">${icons.moon}</button>
    </div>
  </div>`;
}

const FRAMES = [
  {
    dir: "foundry",
    mode: "light",
    title: "Foundry, light",
    note:
      "<b>Parts catalog.</b> Square corners, one pixel rules, a solid ink table header, and an oxide accent that appears only on the active row and on primary actions. The rail is divided by a rule rather than a shadow.",
  },
  {
    dir: "foundry",
    mode: "dark",
    title: "Foundry, dark",
    note:
      "<b>The same catalog at night.</b> The ink header becomes the darkest band on the page and the accent lifts to a warmer oxide so it still carries 4.5 to 1 against the panel. Structure is unchanged: the rules still do the work.",
  },
  {
    dir: "nightshift",
    mode: "dark",
    title: "Nightshift, dark",
    note:
      "<b>Neumorphic.</b> There are no visible borders anywhere. Every control is the same colour as the surface and is drawn with a light shadow from the top left and a dark one to the bottom right. Fields and chips read as pressed into the panel, buttons as raised out of it. The accent is a cool blue, used only for selection and focus.",
  },
  {
    dir: "nightshift",
    mode: "light",
    title: "Nightshift, light",
    note:
      "<b>The same construction in daylight.</b> The shadows invert but the pairing does not: a white highlight and a cool grey drop. This is the hardest of the four to keep legible, which is why the muted text and the accent were both darkened until the contrast test passed.",
  },
];

const host = document.getElementById("frames");
host.innerHTML = FRAMES.map(
  (f) => `<section class="frame" data-dir="${f.dir}" data-mode="${f.mode}" style="background:var(--bg);color:var(--ink);margin-bottom:26px">
    <div class="frame-bar">
      <strong>${f.title}</strong>
      <span>data-dir="${f.dir}" data-mode="${f.mode}"</span>
    </div>
    <div class="frame-body">
      ${mini(f.dir === "nightshift")}
      ${parts()}
      <p class="note">${f.note}</p>
    </div>
  </section>`
).join("");

// The page ground follows the visitor's system preference so the frames are
// never judged against a clashing background.
document.documentElement.dataset.dir = "foundry";
document.documentElement.dataset.mode = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
