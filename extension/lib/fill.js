// Fill, and the rules about where it may happen.
//
// A field belongs to the page, and the page is not trusted. That single fact shapes
// everything here, and the threat model that justifies each rule is in
// extension/README.md under "What a compromised page can and cannot do".
//
// The shape of the thing:
//
//   - Nothing runs on any page until the user clicks Fill in the popup. There is no
//     declared content script and no listener waiting on a page the user has not
//     asked about. `chrome.scripting.executeScript` is called once, by a click.
//
//   - The injected function arrives with the value already in hand and writes it,
//     or waits up to `ARM_MS` for the user to click a field and then writes it. The
//     value lives in that function's closure, which is an isolated world: page
//     JavaScript cannot read a content script's variables, only what it writes into
//     the DOM.
//
//   - It writes and returns. It reads no page content back out except attributes of
//     the field it wrote into, and it reports no names or values.
//
// `armedFill` below is serialised by `chrome.scripting.executeScript`, so it must be
// self-contained: no imports, no closure over this module. It is exported and tested
// against a real DOM in test/extension.test.mjs, which is the only way to check an
// injected function without a browser.

/** How long a click on Fill waits for the user to click a field. */
export const ARM_MS = 20000;

/** Only these are pages a secret has any business being typed into. */
const WEB = /^https?:$/;

/**
 * Should the popup offer Fill on this tab at all.
 *
 * Returns a reason rather than a bare boolean, because the popup has to say why it
 * cannot fill instead of showing a button that fails.
 *
 * The vault's own origin is refused. The only field there is the master password,
 * and filling an API key into it would be a confusing way to lock someone out of
 * their vault.
 */
export function fillTarget(url, vaultOrigin = "") {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return { ok: false, reason: "not-web-page" };
  }
  if (!WEB.test(parsed.protocol)) return { ok: false, reason: "not-web-page" };
  if (vaultOrigin && parsed.origin === vaultOrigin) return { ok: false, reason: "vault-page" };
  return { ok: true, reason: "" };
}

/**
 * The sentence the popup shows when Fill is not available. Fixed strings, so
 * nothing the page supplies is ever rendered.
 */
export function fillReasonText(reason) {
  switch (reason) {
    case "not-web-page":
      return "Fill works on a web page, not here.";
    case "vault-page":
      return "This is the vault. Fill is for other sites.";
    default:
      return "";
  }
}

/**
 * Write `value` into a field, now or on the user's next click.
 *
 * Injected into the page. Everything it needs is in its two arguments.
 *
 * `ttlMs` bounds how long it will wait. Without a bound, a click on Fill followed by
 * a change of mind would leave a live secret in a page's isolated world until the
 * tab closed, and the honest description of the feature has to be "for twenty
 * seconds", not "until something happens".
 */
export function armedFill(value, ttlMs) {
  // A field, not a decoy. The page can move or stub any element it likes, so each
  // of these is checked at the moment of writing rather than when arming.
  var WRITABLE = ["text", "password", "search", "tel", "url", "email", ""];
  function isField(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return WRITABLE.indexOf(String(el.getAttribute("type") || "").toLowerCase()) !== -1;
  }

  // A field the page keeps off screen is a clipboard, not a field. Filling one hands
  // the secret to the page with no user visible sign that it happened.
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Not `Number(style.opacity) === 0`: an unset opacity is the empty string and
    // Number("") is 0, which would read every ordinary field as fully transparent.
    if (style.opacity !== "" && Number(style.opacity) === 0) return false;
    var box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  }

  function write(el) {
    // The native setter, then input and change. A framework that overrode the value
    // setter would take `el.value = x` silently and post an empty form, which reads
    // to the user as "fill did nothing".
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  var armed = true;
  function stop() {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("click", onClick, true);
    // Drop the reference so the value is not reachable from this closure afterwards.
    value = "";
  }

  function tryFill(el) {
    if (!isField(el) || !isVisible(el)) return false;
    // Write first, then stop. Stopping blanked `value` and this ran in the other
    // order at first, so the field was filled with the empty string and the test
    // that checked the field's contents was the only thing that noticed.
    write(el);
    stop();
    return true;
  }

  var onFocus = function (e) {
    tryFill(e.target);
  };
  // A click can arrive before focus does on some pages, and on a fake field that
  // never takes focus. Both are worth filling.
  var onClick = function (e) {
    tryFill(e.target);
  };

  // The common case: the user was already in the field, opened the popup, and asked.
  if (tryFill(document.activeElement)) return { ok: true, how: "focused" };

  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("click", onClick, true);
  var timer = setTimeout(stop, Number(ttlMs) || 20000);
  return { ok: true, how: "armed" };
}
