// Background worker.
//
// It does almost nothing on purpose. Manifest V3 stops the worker when it is idle,
// so anything held in a variable here is gone within seconds and cannot be relied
// on. The vault session lives in a HttpOnly cookie in the browser's cookie jar,
// which is the one piece of state that survives the worker sleeping.
//
// What it does provide is the part a popup cannot: knowing whether the vault is
// reachable and unlocked, from a context that is not about to close.
//
// There is no content script. Nothing runs on any page you visit until you click
// Fill in the popup, which injects one function for twenty seconds. A content
// script would run on every page and would have to be trusted not to read page
// content; injection on a click has a much smaller surface. Fill itself, and what
// a compromised page can and cannot do with it, is in README.md and lib/fill.js.
// Nothing here reads page content, and this worker cannot type into a field.

import { session, matchHost, state, hostOf } from "./lib/client.js";

const BADGE_OK = "#a8402a";
const BADGE_LOCKED = "#666d78";
const BADGE_OFF = "#3d434d";

/** A dot on the toolbar icon: reachable and unlocked, reachable and locked, or not there. */
async function refreshBadge() {
  try {
    const s = await session();
    if (s.unlocked) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_OK });
      await chrome.action.setTitle({ title: "Hasp, unlocked" });
    } else {
      await chrome.action.setBadgeText({ text: "•" });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_LOCKED });
      await chrome.action.setTitle({ title: "Hasp, locked" });
    }
  } catch {
    await chrome.action.setBadgeText({ text: "–" });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_OFF });
    await chrome.action.setTitle({ title: "Hasp, the vault is not running" });
  }
}

/**
 * How many items match the active tab, shown on the badge.
 *
 * Reads the item list only when the vault is unlocked. A locked vault is asked once
 * and not again until the next tab change, so a locked machine is not polled.
 */
async function badgeForTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const host = hostOf(tab?.url);
  if (!host) return refreshBadge();

  try {
    const s = await session();
    if (!s.unlocked) {
      await chrome.action.setBadgeText({ text: "•" });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_LOCKED });
      return;
    }
    const { items = [] } = await state();
    const n = matchHost(items, host).length;
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_OK });
  } catch {
    await chrome.action.setBadgeText({ text: "–" });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_OFF });
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => badgeForTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === "complete") badgeForTab(tabId);
});
chrome.runtime.onInstalled.addListener(() => refreshBadge());
chrome.runtime.onStartup.addListener(() => refreshBadge());

// The popup tells the worker when it unlocks or locks, so the badge does not wait
// for a tab change to catch up.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "hasp:refresh") return false;
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => (tab?.id ? badgeForTab(tab.id) : refreshBadge()))
    .then(() => reply({ ok: true }))
    .catch(() => reply({ ok: false }));
  return true;
});
