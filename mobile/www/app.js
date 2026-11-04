// The phone app.
//
// Two screens. Without a pairing it asks for an address and a code. With one it
// shows the current codes and nothing else.
//
// There is no vault browser, no search across secrets and no item detail. That is
// the constraint, not an unfinished feature: a phone is the device most likely to
// be lost, so it holds the smallest useful slice of the vault, and the slice is
// codes that expire in 30 seconds.

import { loadPairing, forgetPairing, pair, codes } from "../src/api.js";
import { esc } from "../src/render.js";

const app = document.getElementById("app");

/** Last known codes, and when they were read. */
let current = { list: [], at: 0 };
let timer = null;

function header(stateText) {
  return `<header><h1>Hasp</h1><span class="state">${esc(stateText)}</span></header>`;
}

/* ------------------------------------------------------------------ setup */

function setupView(message = "", kind = "error") {
  clearInterval(timer);
  timer = null;
  app.innerHTML = `
    ${header("Not paired")}
    <main>
      <div class="setup">
        <h2>Pair with your vault</h2>
        <p>Open the vault on your computer, choose Pair a phone, and type the code it shows.</p>
        <form id="pair-form">
          <label>Vault address
            <input id="address" name="address" inputmode="url" autocapitalize="off" autocorrect="off"
                   spellcheck="false" placeholder="192.168.1.20:3000" />
          </label>
          <label>Pairing code
            <input id="code" name="code" class="code" autocapitalize="characters" autocorrect="off"
                   spellcheck="false" placeholder="ABCD-EFGH-IJKL-MNOP" maxlength="42" />
          </label>
          ${message ? `<p class="${kind === "error" ? "error" : "note"}">${esc(message)}</p>` : ""}
          <button type="submit" id="pair-submit">Pair</button>
        </form>
        <p class="warn">The connection uses plain http on your local network. Someone on that network with the right tools can see the codes as they travel. Do not pair on a network you do not trust.</p>
        <p class="note">The vault must be running with HASP_HOST set, so it answers on your network rather than only on the machine itself.</p>
      </div>
    </main>
  `;

  app.querySelector("#pair-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = app.querySelector("#pair-submit");
    button.disabled = true;
    button.textContent = "Pairing";
    try {
      await pair(app.querySelector("#address").value, app.querySelector("#code").value);
      await boot();
    } catch (err) {
      setupView(err.message || "That did not work.");
    }
  });
}

/* ------------------------------------------------------------------ codes */

/** Seconds left in the current window, from the clock rather than the payload. */
function remaining(step, now = Date.now()) {
  return step - (Math.floor(now / 1000) % step);
}

function group(code) {
  const s = String(code || "").replace(/\s+/g, "");
  return s.length === 6 ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

function codesView() {
  app.innerHTML = `
    ${header("Paired")}
    <main>
      <div class="codes" id="codes">
        ${
          current.list.length
            ? current.list
                .map(
                  (c) => `<button class="code" type="button" data-copy="${esc(c.code)}" data-id="${esc(c.id)}">
                  <span class="who">${esc(c.name)}</span>
                  <span class="digits">${esc(group(c.code))}</span>
                  <span class="bar" aria-hidden="true"><i data-bar="${esc(c.id)}" style="width:${Math.round((remaining(c.step) / c.step) * 100)}%"></i></span>
                </button>`,
                )
                .join("")
            : `<div class="empty"><strong>No codes yet</strong><span>Add a one-time code in the vault, and it appears here.</span></div>`
        }
      </div>
      <p class="note" style="margin-top:18px">Pick one to copy it. The clipboard is cleared after 25 seconds.</p>
      <p class="note" style="margin-top:10px"><button class="quiet" id="unpair" type="button">Forget this vault</button></p>
    </main>
  `;

  app.querySelectorAll("[data-copy]").forEach((el) => el.addEventListener("click", () => copy(el.dataset.copy)));
  app.querySelector("#unpair").addEventListener("click", async () => {
    await forgetPairing();
    setupView("This phone forgot the vault. Pair again to use it.", "note");
  });
}

let toastTimer = null;
function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  app.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 1800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Could not copy");
    return;
  }
  // Same reasoning as the extension: a code stays valid for the rest of its window,
  // and the clipboard is readable by every app on the phone.
  setTimeout(async () => {
    try {
      const now = await navigator.clipboard.readText();
      if (now === text) await navigator.clipboard.writeText("");
    } catch {
      // Reading the clipboard needs permission on iOS. Not worth a message.
    }
  }, 25000);
}

/* ------------------------------------------------------------------ clock */

/**
 * Move the depletion bars every second and refetch when a window rolls over.
 *
 * The refetch is what keeps the code correct. Guessing the next code locally would
 * need the totp secret on the phone, which is exactly what this design avoids.
 */
function startClock() {
  clearInterval(timer);
  timer = setInterval(async () => {
    if (!current.list.length) return;
    let rolled = false;
    for (const c of current.list) {
      const bar = app.querySelector(`[data-bar="${c.id}"]`);
      const left = remaining(c.step);
      if (bar) bar.style.width = `${Math.round((left / c.step) * 100)}%`;
      if (left === c.step) rolled = true;
    }
    if (rolled) await refresh();
  }, 1000);
}

async function refresh() {
  let next;
  try {
    next = await codes();
  } catch (err) {
    return problem(err);
  }
  current = { list: next.codes, at: next.at };
  if (!app.querySelector("#codes")) return codesView();

  // Update only the digits, so the scroll position and the bars survive.
  for (const c of current.list) {
    const digits = app.querySelector(`[data-id="${c.id}"] .digits`);
    if (digits) digits.textContent = group(c.code);
    const button = app.querySelector(`[data-id="${c.id}"]`);
    if (button) button.dataset.copy = c.code;
  }
}

/** One place for the four ways a fetch can end, so the messages stay consistent. */
async function problem(err) {
  if (err.code === "revoked" || err.code === "unpaired") {
    await forgetPairing();
    setupView("This phone is no longer paired. Pair again to use it.", "note");
    return;
  }
  const hint =
    err.code === "locked"
      ? "Unlock it on your computer, then come back."
      : err.code === "no_crypto"
        ? "This browser view cannot sign requests."
        : "Check that the vault is running and that you are on the same network.";
  app.innerHTML = `${header(err.code === "locked" ? "Locked" : "No connection")}
    <main>
      <div class="empty"><strong>${esc(err.message)}</strong><span>${esc(hint)}</span></div>
      <p class="note" style="margin-top:16px"><button class="quiet" id="retry" type="button">Try again</button></p>
    </main>`;
  app.querySelector("#retry").addEventListener("click", boot);
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  const saved = await loadPairing();
  if (!saved) return setupView();

  let next;
  try {
    next = await codes();
  } catch (err) {
    return problem(err);
  }
  current = { list: next.codes, at: next.at };
  codesView();
  startClock();
}

// Coming back to the app after a while should show a fresh code, not one that
// expired while the screen was off.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && current.list.length) refresh();
});

boot();
