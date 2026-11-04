# Hasp

A vault for API keys, backup codes and one-time codes.

Two design directions, each with a light and a dark mode, and a working vault behind them.
This is no longer only a design exploration: the web dashboard reads and writes a real encrypted
vault, parses real exports, and generates real one-time codes.

**Sample build.** Every item in the vault is invented. The sample master password is printed on the
unlock screen on purpose. Do not put a real secret in this repository or in this build.

## Run it

```
npm install
npm start          # http://localhost:3000
npm test           # 181 cases
```

Requires Node 22 or newer. No database, no environment variables, no network access at runtime.

- `/` is the vault.
- `/themes.html` shows all four surfaces on one page: Foundry light, Foundry dark, Nightshift light,
  Nightshift dark. Same markup, same components, only tokens change.

The sample password is `foundry-nightshift-2026`, filled in for you.

## The two directions

Pick a direction and a mode independently, from the top right of any view or from Settings. Both
choices persist on the device, default to Foundry, and follow the system mode on a first visit.

**Foundry.** A parts catalog. Square corners, one pixel rules, a solid ink table header, one oxide
accent on the active row and on primary actions. Structure does the work; the interface reads like a
store room that runs well.

**Nightshift.** Neumorphism, kept legible. There are no visible borders. Every control is the same
colour as the surface and is drawn with a paired light and dark shadow, so fields and chips read as
pressed into the panel and buttons as raised out of it. The accent appears on selection and focus
only.

Both directions clear WCAG 2.1 AA for text, and the accent clears 3:1 as a graphical object.
`test/theme.test.mjs` parses `src/web/tokens.css` and fails the build if any of the four combinations
drops below the floor, so the palette cannot drift quietly.

## What actually works

- **Vault.** Create, edit, delete, restore, search, filter by type and environment, copy with a
  30 second clipboard clear, reveal, rotate with a version history.
- **Encryption.** scrypt key derivation with recorded parameters, a random vault key wrapped by the
  password key, per item keys, and item ciphertext that binds the vault, item and version as
  additional authenticated data.
- **Blind search.** Item tokens are HMAC'd under a key derived from the vault key, so a search
  matches without the stored record holding readable text.
- **One-time codes.** RFC 6238, checked against the RFC's own test vectors, rolling once a second in
  the page.
- **Backup codes.** Sets with per code used state and an unused count. One code is copied at a time;
  there is no copy-all.
- **Import.** Google Keep JSON and HTML, otpauth exports, and password manager CSV, with a confidence
  score per field and a review step. Anything under 70 percent stays in review.
- **Export.** A plaintext JSON download, with the warning it deserves.

## What does not work yet

Stated here rather than implied by a screen:

- **The browser extension, the desktop app and the mobile app do not exist.** The design boards
  show them; the product does not have them. Phase 2 and later in `PLAN.md`.
- **No sync.** One vault, in one process, on one machine.
- **No accounts.** The session is one cookie and an in-memory vault key.
- **The cipher is not XChaCha20-Poly1305.** `PLAN.md` specifies it; the platform's crypto provides
  `chacha20-poly1305` with a 12 byte nonce, so `src/core/crypto.js` says exactly that and must be
  replaced with libsodium before real secrets are stored.
- **Not audited.** `IMPLEMENTATION_REVIEW.md` asks for an independent cryptographic review before
  real data. That has not happened.
- **Passkey unlock** is a column in the vault record and nothing else.

## Repository

```
server.mjs              preview server: JSON API, sessions, static files, one origin
src/core/               vault, crypto, kdf, wrap, sessions, totp, backup codes, parsers, seed
src/web/                the client: tokens, components, appearance, app, icons
src/web/brands/         586 company marks, vendored so the app loads with no network
test/                   181 cases: core, totp, parsers, theme contrast, API, interface
tools/brands.mjs        regenerates brand names and host matches from the mockup registry
tools/shoot.mjs         optional PNG captures, needs a local Chromium
mockups/                the twelve design directions, 72 rendered images, brand library
PLAN.md                 the original architecture proposal, crypto, data model, phases
IMPLEMENTATION_REVIEW.md  decisions for review, delivery phases, gates
STEP_BY_STEP.md         the working sequence and who acts
tasks.md                the task list and phase gates
DEPLOYMENT.txt          how to publish the design preview
```

## Design provenance

The dashboard, the popup, the mobile screens and the import review all come from `mockups/`, which
holds twelve directions and 72 rendered images. Foundry and Nightshift were chosen from that set.
Every key, code and account row in the mockups and in this build carries the real mark of its
company, from the Simple Icons and SVG Logos sets, vendored with the repository. Marks belong to
their owners and appear for identification only.
