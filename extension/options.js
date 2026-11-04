// The settings page.
//
// The address field is the only thing here that can be saved, and the validator is
// the one in lib/client.js, so the page cannot accept an address the popup would
// refuse to use.

import { getOrigin, setOrigin, normaliseOrigin, session, lock, DEFAULT_ORIGIN } from "./lib/client.js";

const form = document.getElementById("origin-form");
const input = document.getElementById("origin");
const status = document.getElementById("origin-status");
const sessionLine = document.getElementById("session-line");

function say(text, kind = "ok") {
  status.textContent = text;
  status.className = kind;
}

async function refreshSession() {
  try {
    const s = await session();
    sessionLine.textContent = s.unlocked
      ? "The vault is unlocked. The extension shares that session with the browser tab."
      : "The vault is locked. Unlock it from the popup or the vault tab.";
  } catch {
    sessionLine.textContent = "The vault did not answer at this address.";
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const saved = await setOrigin(input.value);
    input.value = saved;
    say(`Saved. The extension will use ${saved}.`);
    await refreshSession();
  } catch (err) {
    say(err.message, "bad");
  }
});

document.getElementById("test").addEventListener("click", async () => {
  const clean = normaliseOrigin(input.value);
  if (!clean) return say("That is not an http loopback address.", "bad");
  try {
    const res = await fetch(`${clean}/api/session`, { credentials: "include" });
    if (!res.ok) return say(`The vault answered ${res.status}.`, "bad");
    const s = await res.json();
    say(s.unlocked ? "Reachable, and unlocked." : "Reachable, and locked.");
  } catch {
    say("Nothing answered at that address.", "bad");
  }
});

document.getElementById("lock").addEventListener("click", async () => {
  try {
    await lock();
    await refreshSession();
  } catch (err) {
    sessionLine.textContent = err.message;
  }
});

const origin = await getOrigin();
input.value = origin;
input.placeholder = DEFAULT_ORIGIN;
await refreshSession();
