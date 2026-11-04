// The popup.
//
// Three states, in this order of precedence: the vault is not running, the vault is
// locked, the vault is open. Each one has a different job, so each renders
// separately rather than sharing a template that fits none of them.
//
// The popup closes when focus moves, which is why nothing here keeps a code on
// screen for long or requires a second click to reveal anything.

import { session, state, unlock, lock, matchHost, getOrigin } from "./lib/client.js";
import { esc, itemRow, empty, banner, groupCode } from "./lib/render.js";

const view = document.getElementById("view");
const stateLabel = document.getElementById("state");
const footNote = document.getElementById("foot-note");

/** What the last render was, so the clock can update codes without re-fetching. */
let current = { kind: "loading", items: [], query: "", host: "" };

/** The active tab's hostname, which becomes the first thing the popup offers. */
async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return "";
    const { hostname, protocol } = new URL(tab.url);
    return protocol === "http:" || protocol === "https:" ? hostname : "";
  } catch {
    return "";
  }
}

function setStateLabel(text) {
  stateLabel.textContent = text;
}

/** Ask the worker to bring the badge up to date. Fire and forget. */
function nudgeWorker() {
  chrome.runtime.sendMessage({ type: "hasp:refresh" }).catch(() => {});
}

/* ------------------------------------------------------------------ views */

function renderOffline(error) {
  current = { kind: "offline", items: [], query: "", host: "" };
  setStateLabel("Not running");
  view.innerHTML = `
    ${banner(error?.message || "The vault did not answer.", "error")}
    ${empty("The vault is not running", "Start it with npm start, then open this popup again.")}
    <p class="section">Address</p>
    <p style="margin:0;color:var(--mut)">${esc(document.body.dataset.origin || "")}</p>
  `;
  getOrigin().then((origin) => {
    if (current.kind === "offline") {
      const el = view.querySelector("p:last-of-type");
      if (el) el.textContent = origin;
      document.body.dataset.origin = origin;
    }
  });
}

function renderGate({ message = "", wait = 0 } = {}) {
  current = { kind: "gate", items: [], query: "", host: "" };
  setStateLabel("Locked");
  view.innerHTML = `
    <form class="gate" id="gate">
      ${message ? banner(message, "error") : ""}
      <label for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" required ${wait ? "disabled" : "autofocus"} />
      <button class="primary" type="submit" ${wait ? "disabled" : ""}>
        ${wait ? `Try again in ${wait}s` : "Unlock"}
      </button>
    </form>
    ${empty("The vault is locked", "Unlocking here unlocks it for the browser tab too.")}
  `;
  const form = view.querySelector("#gate");
  const input = view.querySelector("#pw");
  if (!wait) input?.focus();
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Unlocking";
    try {
      await unlock(input.value);
      input.value = "";
      await boot();
      nudgeWorker();
    } catch (err) {
      // The server throttles guesses, so a failure carries how long to wait.
      const retry = /\b(\d+)\s*s(?:econds?)?\b/i.exec(err.message);
      renderGate({ message: err.message, wait: retry ? Number(retry[1]) : 0 });
    }
  });
}

/** Relevance first, then everything else, with the tab's matches named. */
function renderVault() {
  const { items, query, host } = current;
  setStateLabel("Open");

  // The query is answered by the vault, not by narrowing this list. Searching here
  // meant a match in a note was invisible, because notes never reach the popup.
  const q = query.trim();
  const visible = items;

  // Host matching is still local, because it is a lookup on the tab's hostname and
  // has nothing to do with what was typed.
  const relevant = q ? [] : matchHost(items, host);
  const relevantIds = new Set(relevant.map((i) => i.id));
  const rest = visible.filter((i) => !relevantIds.has(i.id));

  view.innerHTML = `
    <input class="search" id="search" type="search" placeholder="Search ${items.length} items"
           value="${esc(query)}" autocomplete="off" spellcheck="false" ${items.length ? "autofocus" : ""} />
    <div id="results">
      ${!items.length ? empty("Nothing in the vault yet", "Add something from the vault tab.") : ""}
      ${relevant.length ? `<p class="section">For ${esc(host)}</p><ul class="items">${relevant.map((i) => itemRow(i)).join("")}</ul>` : ""}
      ${rest.length ? `<p class="section">${relevant.length ? "Everything else" : "Items"}</p><ul class="items">${rest.map((i) => itemRow(i)).join("")}</ul>` : ""}
      ${visible.length === 0 && items.length ? empty("No match", `Nothing matches "${query}".`) : ""}
    </div>
  `;
  const search = view.querySelector("#search");
  search?.addEventListener("input", () => {
    current.query = search.value;
    searchNow(search.value);
    // renderVault rebuilds the whole view, field included, so focus and caret are put
    // back here rather than assumed to survive.
    const next = view.querySelector("#search");
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
  });
}

/* ----------------------------------------------------------------- search */

let searchTimer = null;
let searchSeq = 0;

/**
 * Ask the vault for the matches.
 *
 * Debounced, and sequence guarded, so a slow reply for an earlier keystroke cannot
 * land on top of a later one. An empty query is not debounced: clearing the field
 * should bring the list back at once.
 */
async function searchNow(query) {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const run = async () => {
    try {
      const { items = [] } = await state(query);
      if (seq !== searchSeq) return;
      current = { ...current, items, query };
      renderVault();
    } catch (err) {
      if (seq !== searchSeq) return;
      if (err.code === "locked") return renderGate();
      renderOffline(err);
    }
  };
  if (!query.trim()) return run();
  searchTimer = setTimeout(run, 120);
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const host = await activeHost();
  current.host = host;
  try {
    const s = await session();
    if (!s.unlocked) return renderGate();
    const { items = [] } = await state();
    current = { kind: "vault", items, query: "", host };
    renderVault();
  } catch (err) {
    if (err.code === "locked") return renderGate();
    renderOffline(err);
  }
}

/* ------------------------------------------------------------- clipboard */

/**
 * Copy, with the field cleared afterwards.
 *
 * A code stays valid for the rest of its window, so leaving it on the clipboard
 * for an hour is a real exposure. The clear is best effort: a clipboard another
 * app has taken over is not ours to rewrite, and failing to clear must not look
 * like failing to copy.
 */
async function copyText(text, button, restoreAfter = 25000) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
  setTimeout(async () => {
    try {
      const now = await navigator.clipboard.readText();
      if (now === text) await navigator.clipboard.writeText("");
    } catch {
      // Clipboard read needs a gesture or a permission. Not worth a message.
    }
  }, restoreAfter);
  return true;
}

view.addEventListener("click", async (e) => {
  const codeButton = e.target.closest("[data-copy-code]");
  if (codeButton) {
    const item = current.items.find((i) => i.id === codeButton.dataset.copyCode);
    const code = String(item?.totp?.code || "").replace(/\s+/g, "");
    if (code) await copyText(code, codeButton);
    return;
  }
  const valueButton = e.target.closest("[data-copy-value]");
  if (valueButton) {
    // The list endpoint already includes values, so this is a straight copy of
    // what is in hand. No second request, and nothing new leaves the vault.
    const item = current.items.find((i) => i.id === valueButton.dataset.copyValue);
    if (item?.value) await copyText(item.value, valueButton);
  }
});

document.getElementById("open-vault").addEventListener("click", async () => {
  const origin = await getOrigin();
  chrome.tabs.create({ url: `${origin}/app` });
  window.close();
});

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

/* ------------------------------------------------------------------ clock */

// Codes are recomputed for the next window without a request: the vault sends the
// current code and the parameters, and the counter can be derived from the clock.
// A wrong clock makes a wrong code, which is why the vault remains the authority
// and this only fills the seconds between requests.
setInterval(() => {
  if (current.kind !== "vault") return;
  for (const item of current.items) {
    if (!item.totp?.code) continue;
    const seconds = Math.floor(Date.now() / 1000);
    const left = (item.totp.step || 30) - (seconds % (item.totp.step || 30));
    if (left === (item.totp.step || 30)) {
      // The window just rolled over. Ask the vault rather than guessing a code.
      boot();
      return;
    }
  }
}, 1000);

footNote.textContent = "Codes are computed by the vault, not here.";
boot();
