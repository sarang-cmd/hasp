// Shared rendering, so the popup and the options page cannot drift apart.
//
// Escaping is the first thing here because every string below comes from a vault
// the user controls. An item named with a `<script>` tag is a plausible thing to
// import from a notes app, and this code runs with extension privileges.

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** "123456" -> "123 456", which is how a person reads a code aloud. */
export function groupCode(code) {
  const s = String(code || "").replace(/\s+/g, "");
  return s.length === 6 ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** Which seconds are left in the current 30 second window, for the depletion bar. */
export function secondsLeft(step = 30, now = Date.now()) {
  return step - (Math.floor(now / 1000) % step);
}

/** The initials a tile shows when there is no company mark to draw. */
export function initials(name) {
  const words = String(name || "")
    .trim()
    .split(/[\s-_]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * One item row.
 *
 * `copyable` is false while locked, because there is nothing to copy and a button
 * that fails is worse than no button.
 */
export function itemRow(item, { copyable = true, fillable = false } = {}) {
  const code = item.totp?.code ? groupCode(item.totp.code) : "";
  // A code cannot be filled into a form, and a copy that needs the clipboard is a
  // worse answer than a fill when the user is looking at a login box. Both are
  // offered when both make sense, fill first because it is the one that finishes
  // the job.
  const copy = code
    ? `<button class="copy" type="button" data-copy-code="${esc(item.id)}" aria-label="Copy the code for ${esc(item.name)}">${esc(code)}</button>`
    : item.value && copyable
      ? `<button class="copy" type="button" data-copy-value="${esc(item.id)}" aria-label="Copy ${esc(item.name)}">Copy</button>`
      : "";
  const fill = item.value && fillable
    ? `<button class="copy" type="button" data-fill="${esc(item.id)}" aria-label="Fill ${esc(item.name)} into the page">Fill</button>`
    : "";
  const action = copy + fill;

  return `<li class="item" data-id="${esc(item.id)}">
    <span class="tile" aria-hidden="true">${esc(initials(item.name))}</span>
    <span class="meta">
      <strong>${esc(item.name)}</strong>
      <span class="sub">${esc(item.host || item.service || "")}${item.env ? ` · ${esc(item.env)}` : ""}</span>
    </span>
    ${action}
  </li>`;
}

/** The empty state, which says why it is empty rather than just being blank. */
export function empty(message, hint = "") {
  return `<div class="empty"><strong>${esc(message)}</strong>${hint ? `<span>${esc(hint)}</span>` : ""}</div>`;
}

/** A one line message under the header, used for errors and confirmations. */
export function banner(text, kind = "info") {
  return `<p class="banner banner--${esc(kind)}" role="status">${esc(text)}</p>`;
}
