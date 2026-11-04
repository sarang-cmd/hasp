# Hasp, implementation plan

Working name: Hasp. Status: design exploration done, 12 directions and 72 mockup images.

Current planning note: this document preserves an earlier proposal, not approved defaults or a description of production readiness. IMPLEMENTATION_REVIEW.md and tasks.md track current decisions and open gates. Hosted AI requires explicit approval and opt-in, and pricing has not been approved. The current server-side prototype is for synthetic data only and does not implement the proposed client-side encryption architecture.

**Built since this plan was written.** Foundry and Nightshift were chosen from the twelve
directions, and a working web vault now exists for them, each in light and dark. See `README.md` for
what runs, and `src/core/` for the crypto that the tests pin down. The sections below are kept as
written so the proposal and the build can be compared; where the build departs from the proposal it
says so in the code, not by quietly editing this file.

The decisions in section 1 are no longer all open. Name: Hasp. Direction: Nightshift is the default,
with Foundry available, both with light and dark. Surfaces: web first. The rest still need your answer.

**Revised after review.** Nightshift leads. It was originally the secondary direction, but the
neumorphic surface was the one worth looking at, so it became the default and Foundry stayed as the
structural alternative. Both remain fully supported; only the first paint changed.

The repository held one README before this work. There was no site to audit, so the audit list from the brief becomes the build standard in sections 8 and 9.

Read the design direction that fits before starting. All twelve use the same markup and content, so the chosen stylesheet moves into the product with minor changes.

Light set: Foundry, Reading Room, Flight Deck, Grid, Native, Halcyon.
Dark set: Nightshift (neumorphism), Brut (neubrutalism), Retrograde (retro futurism), Weimar (Bauhaus), Glasshouse (glassmorphism), Clay (claymorphism).

Trend references come from the DesignerUp list of popular UI styles. Each dark direction keeps one deliberate constraint: contrast and legibility first, trend second.

---

## 1. Decisions

Settled: name Hasp, directions Foundry and Nightshift with an independent light and dark for each,
web dashboard first. Still open. The recommendations below require review and approval:

| Decision | Options | Recommendation for review |
| --- | --- | --- |
| Next surface | Browser extension, or desktop, or mobile | Browser extension, per phase 2 |
| Search model | Client-side index, or encrypted server index | Client-side index |
| AI labels | On-device model, hosted model with redaction, or no model in v1 | Local rules first. Hosted processing disabled until approved and explicitly opted in |
| Pricing | Not set. No prices appear in the mockups | Await your decision |

Domain and trademark checks are not done. Do those before printing the name on anything.

---

## 2. Product scope

One vault, four surfaces.

**Browser extension (Chrome, Edge, Firefox).** Manifest V3. Popup with search and a suggestion for the active host. Quick bar on a keyboard shortcut. Fills the focused field on request. Handles one-time codes and backup code sets. Never fills automatically without a user action in v1.

**Web dashboard.** Vault table, filters by type and environment, item detail with copy and reveal, import review, device list, session and security settings, billing later.

**Desktop app (Electron).** Local encrypted vault, global shortcut, offline access, sync when online. Ships as a Windows installer, a macOS dmg and a Microsoft Store MSIX.

**Mobile app (Expo).** One-time codes first, biometric unlock, search, copy, offline vault.

**Out of scope for v1.** Sharing, teams, password generation for logins, passkey storage, browser autofill of usernames, public API.

---

## 3. Architecture

```
Browser extension --\
Web app (Next.js) ----> API routes on Vercel ----> Neon Postgres
Desktop (Electron) --/          |                      |
Mobile (Expo) ------/           |                      +-- Neon Auth
                                +--> Cloudflare R2 (exports, avatars)
                                +--> Resend (email)
                                +--> PostHog (product events)
                                +--> Stripe (billing, phase 5)
                                +--> 9Router -> Groq (label suggestions, opt in)
```

Choices:

- Next.js 15, App Router, React Server Components for the dashboard shell.
- Neon Postgres with Drizzle for schema and migrations. Neon Auth for sessions. Verify the current Neon Auth API in the Neon console before wiring it, the product is new and the SDK changes.
- Vercel for the app and API routes. Keep background work in queues or cron, not in request handlers.
- Cloudflare R2 for import files and exports. Signed URLs, short expiry, files deleted after 24 hours.
- Extension, desktop and mobile share a TypeScript package for crypto, item models and the import parsers. No duplicated crypto code.
- Sync uses per-item version vectors with last-write-wins on conflict and a visible conflict log. Items are encrypted blobs, so the server never merges content.

---

## 4. Crypto model

The vault is zero knowledge. The server stores ciphertext and cannot read item names, notes or values.

- Master password stretches to a key with Argon2id (64 MiB, 3 passes, per-user salt).
- A random 32 byte vault key is wrapped twice: once by the password key and once by a passkey (WebAuthn PRF where supported). Either unwraps it.
- Each item gets a random key. Values encrypt with XChaCha20-Poly1305. Additional data binds item id, item version and vault id.
- Search uses a blind index: HMAC of normalized tokens with a key derived from the vault key. Server sees hashes only. Client-side search reads the local decrypted index.
- Metadata kept in clear for sync: id, type, version, created and updated timestamps, deleted flag. Nothing else.
- Auto-lock after 5 minutes idle, on window blur for the extension, and on device lock.
- Clipboard clears after 30 seconds and never holds backup code sets for more than one copy.
- Mobile blocks screen recording on the code screen where the platform allows it.
- Recovery: printable recovery kit with a recovery key that wraps the vault key. No server-side reset.

AI labeling tension: a hosted model needs plaintext. Default path is on-device parsing with rules, plus a hosted call only when the user opts in for a batch. The redaction pass strips anything that looks like a secret (long tokens, base32 blocks, private key headers) before text leaves the device. Document this in the privacy policy in plain words.

---

## 5. Data model

```
users            id, email, created_at
vaults           id, owner_id, name, kdf_params, wrapped_key_password, wrapped_key_passkey
items            id, vault_id, type, ciphertext, nonce, version, search_tokens[], created_at, updated_at, deleted_at
item_versions    id, item_id, ciphertext, nonce, version, device_id, created_at
devices          id, user_id, name, platform, public_key, last_seen_at, revoked_at
imports          id, vault_id, source, file_key, status, counts, created_at
audit_events     id, vault_id, device_id, action, item_id, created_at
subscriptions    id, user_id, stripe_customer_id, plan, status, period_end
```

Rules: every table carries `vault_id` or `user_id`. Row level security on Neon enforces ownership. API routes check ownership again, never trusting the client.

---

## 6. Import pipeline

**Google Keep.** Takeout gives HTML and JSON. Parse the JSON first, fall back to HTML. Each note becomes a candidate with raw text, labels, timestamps and attachments ignored in v1. Duplicates detected with the blind index on normalized values.

**One-time codes.** Accept `otpauth://` URIs, Aegis JSON, 2FAS JSON, andOTP JSON and plain text exports. Google Authenticator exports QR codes only, as a group of images. Support image upload and QR decode. Microsoft Authenticator has no export path. Say so on the import screen instead of pretending.

**Password manager CSV.** 1Password, Bitwarden, Chrome, LastPass, Dashlane and KeePass XML. Read the header, map columns, never upload the original file to storage unless the user keeps it.

**Parsing.** Detect key shapes (Groq, Stripe live and test, GitHub, OpenAI, AWS, Cloudflare, Neon, Supabase, Resend, Vercel), backup code blocks (8 to 12 lines of short alphanumeric groups), connection strings, and TOTP URIs. Score each field 0 to 1. Anything under 0.7 goes to manual review.

**Review screen.** Left column keeps the original note text. Right column shows parsed fields with confidence and lets the user fix a field. Accept one, accept all, or skip. The mockups show this screen with sample data.

---

## 7. Smart selection

Ranking runs on the client. Inputs: current host, field hints from the page, item labels, environment, last use, device, and whether the key shape matches the site. Output: one suggested item plus a short reason line, the same line used in the mockups ("Host matches console.groq.com, prod label").

Rules first. A model is optional and only refines labels and service names, never the fill decision. Keep the ranking explainable, because a wrong suggestion fills a production key into a staging form.

---

## 8. Security baseline

- CSP with nonces, no inline script, `frame-ancestors 'none'`.
- HSTS with preload, HTTPS only, secure cookies (`HttpOnly`, `Secure`, `SameSite=Lax`).
- CSRF tokens on all state-changing routes, plus origin checks.
- Rate limits per IP and per user on auth, item read, import upload and AI calls. Use Upstash or Vercel KV.
- Uploads validated by type and size, scanned, stored outside the app origin, deleted after processing.
- Secrets only in Vercel environment variables. No key in client bundles. A pre-commit hook and a CI check scan for key patterns.
- Spend caps on Groq, Resend, PostHog, Stripe test mode, R2 and Neon. Alert at 50 and 80 percent.
- Admin routes behind a separate role claim and an allowlist of user ids.
- Dependency review and a lockfile in CI. No remote code in the extension, which store review checks.
- A public security page with a contact address and a threat model summary.

---

## 9. Marketing site baseline

Separate routes, not one long page. Home, product pages for extension, dashboard, desktop and mobile, pricing, security, about, blog index, three posts, contact, privacy, terms, 404.

Every page: unique title, meta description, canonical, OG image, one `h1`, breadcrumbs, skip link, footer with legal links and a visible contact email. `sitemap.xml`, `robots.txt` that allows AI crawlers, `llms.txt`, JSON-LD for organization and software application.

No invented reviews, customer counts, metrics or logos. Pricing appears only when the numbers exist. Legal pages come from the real data practices; mark unfinished clauses as drafts for a lawyer. Cookie banner only if non-essential cookies run.

Targets: Lighthouse 90 and above on mobile, LCP under 2.5 seconds, JS under 150 KB on the marketing pages, WCAG 2.1 AA.

---

## 10. Build order

Phase 0, week 1. Pick name and direction. Set up the monorepo, Neon project, Vercel project, auth, CI, environment handling, and the design tokens from the chosen direction.

Phase 1, weeks 2 to 4. Crypto package with tests. Web dashboard: vault list, item detail, create, edit, delete, copy and reveal. Devices and sessions. Basic audit log.

Phase 2, weeks 5 to 7. Extension: popup, quick bar, fill, one-time codes, unlock flow, IndexedDB cache. Chrome and Edge first, Firefox after.

Phase 3, weeks 8 to 10. Import: Keep, TOTP, CSV. Review screen. Label suggestions behind a flag with the redaction pass.

Phase 4, weeks 11 to 12. Desktop: Electron shell, SQLite cache, global shortcut, auto update, Windows and macOS builds, MSIX for the Store.

Phase 5, weeks 13 to 14. Mobile beta: Expo app, biometrics, one-time codes, sync.

Phase 6, weeks 15 to 16. Hardening, store listings, privacy and terms review, load tests, spend caps, launch checklist.

Each phase ends with a working build on Vercel and a signed extension build.

---

## 11. Risks

- Google Authenticator export is QR based, not text. Plan the QR path early or drop the claim.
- Manifest V3 service workers sleep. Keep the vault key in memory only while a session is active and re-prompt when needed.
- Electron code signing costs money and takes days. Start the certificate and Microsoft Store paperwork in phase 0.
- Zero knowledge limits server-side search and AI features. Be explicit in the UI about what leaves the device.
- Neon Auth is new. Pin the SDK, wrap it behind one adapter and keep a fallback to a plain session table.

---

## 12. What sits in this repository

```
mockups/
  index.html              hub, names, 12 directions
  browse.html             thumbnail browser, filter by light or dark, full screen set per direction
  gallery.html            all 72 images
  brands.html             brand library, 586 company marks with search and filters
  sheet.html              light overview sheet
  sheet-dark.html         dark overview sheet
  0N-*.html               twelve direction pages with live screens
  png/                    72 mockup PNGs at 2x, plus 00-overview.png and 00-overview-dark.png
  assets/                 board, screens and direction CSS, fonts
  assets/brands/          one SVG per company mark
  assets/brands.json      registry: name, domain, category, colour, plate, artwork
  _build/                 page generator, screen markup, direction copy, brand build
  _build/fetch-logos.mjs  optional logo.dev fetch, off by default
PLAN.md                   this file
```

Regenerate pages with `node mockups/_build/build.mjs`, `node mockups/_build/gallery.mjs`, `node mockups/_build/browse.mjs` and `node mockups/_build/brandpage.mjs`. Rebuild the brand registry with `node mockups/_build/brands.mjs` after editing `_build/brand-slugs.mjs`. That step needs `simple-icons` and `@iconify-json/logos` installed; the generated files are committed, so a normal build does not. Images were rendered with headless Chromium at 2x. The dark set uses the same screen markup, so a product can switch theme with tokens and a handful of component rules.

Not done: legal copy, pricing, real product screens, a product icon set beyond the small stroke set in the screens, light and dark pairs for every direction, motion specs.

---

## 13. Brand marks

Every service in the sample vault carries its real mark. The set covers 586 companies that issue keys, run accounts, or offer an API, grouped as identity, security, cloud, dev tools, data, AI, payments, productivity, communication, analytics, commerce and consumer.

Sources are the Simple Icons and SVG Logos sets, installed from npm and vendored into `mockups/assets/brands/`. Simple Icons contributes 499 single colour marks with the published brand hex. SVG Logos contributes 77 full colour marks, which covers brands Simple Icons does not carry, Groq among them. Each mark is one standalone SVG plus an entry in `assets/brands.json` with name, domain, category, colour and plate.

Tiles keep the shape and border of each direction. The plate behind the mark turns light in every direction, because a near black mark on a dark plate disappears. Marks with light fills get a dark plate instead, computed from the artwork. Wide wordmarks scale to fit, so Groq stays a wordmark rather than a cropped letter.

The library page inlines every mark, so it works from disk with no requests. `_build/fetch-logos.mjs` will pull square app icons from logo.dev when a publishable token is set in `LOGO_DEV_TOKEN`. It is optional and off the build path.

Marks belong to their owners and appear for identification only. Both icon sets are CC0. No endorsement is implied.
