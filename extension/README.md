# Browser extension

The popup, the badge, and Fill. It is a client, not a vault: it holds no key, no
master password and no secret. Everything it shows comes from the vault on your
machine over loopback.

Run it from the repository:

    npm run ext      # packages dist/hasp-extension.zip

Then `chrome://extensions`, turn on Developer mode, and load `extension/`
unpacked. It is unsigned and not on any store.

## What it does

- **Search.** The query goes to the vault, so a match in a note is found. The
  popup used to filter its own list by name, service and host, which meant a
  note match was invisible.
- **For the site you are on.** The tab's hostname is matched against item hosts,
  most exact first. `api.stripe.com` finds an item for Stripe.
- **Codes.** The current one-time code, refreshed by asking the vault rather than
  computing it here.
- **Copy.** A value or a code, with the clipboard cleared after 25 seconds.
- **Fill.** Writes an item's value into a field on the page. Below.

## Fill, and why it is shaped this way

A field belongs to the page, and the page is not trusted. That fact rules out the
obvious implementation, which is a content script listening on every page you
visit. Nothing runs on any page until you click Fill.

The sequence:

1. You open the popup on a page and press **Fill** next to an item.
2. The popup calls `chrome.scripting.executeScript` with one function and the
   value as an argument. `scripting` plus `activeTab` is the whole permission
   cost, and `activeTab` is granted by the click.
3. If you were already in a field, it is written immediately and the button says
   **Filled**.
4. Otherwise the function waits, and the popup says **Click a field** and closes.
   Your next click on an input writes the value.
5. It stops after twenty seconds either way, and blanks its own copy of the value.

### What a compromised page can and cannot do

Written out because the service worker's comment used to say this was not built
until it could be justified. This is the justification.

**It cannot make Fill happen.** There is no message any page can send that reaches
the extension. The only trigger is a click in the popup, which is a browser
surface the page cannot draw in or listen to.

**It cannot read the value from the extension.** The injected function runs in an
isolated world. Page JavaScript cannot see a content script's variables or its
closure, so the value is not readable by the page until it is written into the
DOM. After that it is in the field, which is the entire point of the feature.

**It cannot redirect the write to a field of its choosing.** The write goes to the
element the user clicked or focused, and only if that element is an input or
textarea of a writable type, and only if it is genuinely visible: not
`display:none`, not `visibility:hidden`, not `opacity: 0`, and with a real box. A
page that hides an input to catch the value gets nothing. The same check runs at
the moment of writing, so hiding the field after the popup closes does not help
it.

**It cannot get the value into a page it controls.** Fill is refused on anything
that is not `http` or `https`, and refused on the vault's own origin. The vault
page is where the master password goes, and filling an API key into it would be a
confusing way to lock a person out.

**It cannot keep it.** The function clears the value from its closure on the first
write, on timeout, and when the page navigates. It writes no storage and makes no
requests: `lib/fill.js` can reach neither, and a test asserts that it does not.

**What it can still do.** Anything a page can do to a form: read the value back
after it is written, log it, send it somewhere. That is unavoidable, because the
destination of a fill is by definition a field the page owns. Fill is for the site
you are logging into, and it is a smaller trust decision than pasting the value
into that field yourself, which has the same consequence.

**What it does not do.** No autofill on load, no fill without a click, no fill of
usernames, no fill across frames other than the top one, and no fill on a page
whose URL is not readable.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | The vault address, and nothing else |
| `activeTab` | Read the host of the tab you opened the popup on, and inject on your click |
| `scripting` | `executeScript`, for Fill |

`host_permissions` is loopback only. A manifest host permission cannot be
narrowed to a port, so the check happens in `lib/client.js` instead: a stored
address that is not `http` on `127.0.0.1` or `localhost` is refused rather than
used.

There is no `content_scripts` block. A test asserts that, because adding one would
quietly undo the model above.

## What is not verified

The extension has never been loaded in a real browser by the person who wrote it.
The logic is tested with a `chrome` stub, and the injected function is tested
against jsdom, which is a DOM but not Chrome. Field detection on a real login
page, shadow DOM, iframes and the `executeScript` path itself are unverified
until someone loads it.
