<div align="center">

<img src="docs/screens/logo-dark.svg" alt="hasp" width="260">

**The keys you actually use, in one sealed place.**

A local-first vault for API keys, backup codes and one-time codes.<br>
Nightshift and Foundry. Light and dark. One master password.

[Run it](#run-it) · [The four surfaces](#the-four-surfaces) · [What works](#what-actually-works) · [What does not](#what-does-not-work-yet)

</div>

---

<img src="docs/screens/nightshift-dark.png" alt="The Hasp vault in Nightshift dark: a list of API keys on the left, an inspector on the right showing a masked secret and a live one-time code." width="100%">

<div align="center"><sub><b>Nightshift, dark.</b> The default surface. Neumorphism without visible borders.</sub></div>

## Two products in one

Direction and mode are independent: four surfaces, one set of components, and only
the tokens change.

|  | Light | Dark |
| --- | --- | --- |
| **Nightshift** | <img src="docs/screens/nightshift-light.png" alt="Nightshift light"> | <img src="docs/screens/nightshift-dark.png" alt="Nightshift dark"> |
| **Foundry** | <img src="docs/screens/foundry-light.png" alt="Foundry light"> | <img src="docs/screens/foundry-dark.png" alt="Foundry dark"> |

**Nightshift** is neumorphism kept legible. There are no visible borders anywhere.
Every control is the same colour as the surface and is drawn with a paired light
and dark shadow, so fields and chips read as pressed *into* the panel and buttons
as raised *out* of it. The accent appears on selection and focus only.

**Foundry** is a parts catalog. Square corners, one-pixel rules, a solid ink table
header, one oxide accent on the active row. Structure does the work.

Both clear WCAG 2.1 AA for text, and `test/theme.test.mjs` parses
`src/web/tokens.css` and fails the build when any of the four combinations drops
below the floor. The palette cannot drift quietly.

## Run it

```
npm install
npm start            # http://localhost:3000
npm test             # 212 cases
```

Node 22 or newer. No database, no environment variables, no network at runtime.

- `/` is the vault. The sample password is `foundry-nightshift-2026`, filled in.
- `/themes.html` shows all four surfaces at once, rendered from the real components.

**This is a sample build.** Every item in the vault is invented, and every sample
value is worded as an example on purpose. Do not put a real secret in it until
you have read [What does not work yet](#what-does-not-work-yet).

## What actually works

**Vault.** Create, edit, delete, restore, search, filter by type and environment,
copy with a 30 second clipboard clear, reveal, rotate with version history.

**Encryption.** scrypt key derivation with recorded parameters, a random vault key
wrapped by the password key, per-item keys derived from the vault key, and item
ciphertext bound to its vault, id and version as associated data, so a ciphertext
moved to another row fails to open rather than opening as something else.

**One-time codes.** RFC 6238 TOTP over RFC 4226 HOTP, with base32 and `otpauth://`
parsing, checked against the RFC's own vectors. A depletion bar shows the period.

**Backup codes.** Code sets with unused counts, per-code copy, and no "copy all"
affordance, because copying a set is how sets end up in a chat log.

**Import.** Google Keep JSON and HTML, CSV, and `otpauth://` URIs, with confidence
scoring and a review step. A parsed import is single use and expires after 30
minutes.

**Search that does not store your words.** A blind index: queries match on keyed
hashes, so the vault never holds the plaintext of what you searched for.

## What does not work yet

Stated plainly, because the header above says "sealed" and that word has a floor.

- **No browser extension, desktop app or mobile app.** A web page only.
- **No sync, no accounts, no sharing.** One vault, one machine, one password.
- **The cipher is `chacha20-poly1305` with a 12-byte nonce, not the planned
  XChaCha20-Poly1305.** `src/core/crypto.js` says so at the top. Replace it with
  libsodium before a real secret goes in.
- **No independent crypto review.** Tested, not audited.
- **Passkey unlock is a stub.** It renders and stores nothing.
- **The screenshots are generated, not captured.** `tools/render.mjs` draws them
  from the real tokens and the real typefaces, but it draws the layout rather than
  running the app. `npm run png` captures a real browser when one is available.

## Layout

```
server.mjs            one node:http server, static files + JSON API, no dependencies
src/core/             kdf, crypto, wrap, vault, totp, backup codes, parsers, seed
src/web/              the client: tokens, components, app, themes page, brands, fonts
src/web/heroicons/    vendored Heroicons solid, MIT, licence beside them
test/                 212 cases: crypto, TOTP, parsers, contrast, API, and the real client in jsdom
tools/                icon and brand generation, the renderer, the Playwright capture
docs/BRAND.md         the identity: mark, wordmark, colour, clear space
```

The client has **no runtime dependencies** and no CDN. Icons are inlined from the
vendored set, fonts are served from `src/web/fonts`, and the 586 company marks are
local SVGs. It works with the network unplugged.

## Security, honestly

Full detail in [SECURITY.md](SECURITY.md), including the threat model and the parts
that are deliberately out of scope.

- Sessions hold the vault key in process memory with an idle lock; the key is never
  written to disk.
- The cookie is `HttpOnly; SameSite=Strict; Path=/`. Cross-origin POSTs are refused.
- CSP is `default-src 'self'`, with `nosniff`, `DENY` and `no-referrer`.
- Path traversal is refused, including encoded forms.
- Wrong password returns 401 and renders inline. It does not reload the page.

Tests cover each of those. None of it substitutes for the review listed above.

## Licence

MIT for the code. Heroicons is MIT, Tailwind Labs, vendored under
`src/web/heroicons/LICENSE`. Company marks under `src/web/brands` belong to their
owners and are used to label the accounts they identify.
