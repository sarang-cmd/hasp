# What needs you

Everything in this file is something I cannot do from here. It is ordered by how
much it blocks: the first section stops the product from being trustworthy at all,
the rest are decisions, paperwork and money.

**This file is committed to the repository** so it cannot be lost again. It was
written once as an untracked file and did not survive a session reset, which is
exactly the kind of thing that should be committed.

---

## Where the other documents are

All of these are in the repository at `github.com/sarang-cmd/hasp`, at the paths
shown. If you cannot find them on your own machine, they are not missing: run
`git clone` or open the repository on GitHub and they are all there, at the root.

| File | What it is | Is it current? |
| --- | --- | --- |
| `user input.md` | **This file.** What needs your decision or action | Yes |
| `tasks.md` | The real checklist. Every line starting "You:" is yours | Yes, but tracks none of the last ~30 PRs |
| `IMPLEMENTATION_REVIEW.md` | The ten decisions, with a recommendation each | Yes |
| `STEP_BY_STEP.md` | The working sequence. Steps 1, 2, 4, 9, 10 are yours | Yes |
| `SECURITY.md` | Threat model: what is guaranteed, what is not | Yes, except the "no key rotation" line |
| `README.md` | What runs, how to run it, what does not work | Yes, counts kept current |
| `CONTRIBUTING.md` | How to work on it | **No: says 217 tests, actual is 537** |
| `PLAN.md` | The original proposal | **No: its own header says it is historical** |
| `DEPLOYMENT.txt` | Deployment notes | **Mostly stale, see below** |
| `desktop/README.md` | The Electron shell | Mostly; the preload section is stale |
| `mobile/README.md` | The phone client | Yes |
| `docs/BRAND.md` | The identity: mark, wordmark, colour | Yes |
| `extension/README.md` | The extension, and the Fill threat model | Yes |
| `.env.example` | The only file that documents environment variables | Yes, but see section 6 |

---

## 1. The gates I cannot pass

### An independent security review

This is the one that matters, and no amount of further work substitutes for it.
`SECURITY.md` opens by calling the project "a tested sample, not an audited
product", and every line under "What is guaranteed" is backed by a test I wrote.
Tests find the bugs I thought to test for. Every phase gate in `tasks.md` and
`IMPLEMENTATION_REVIEW.md` requires this, and none of them can close without it.

What a reviewer needs: `src/core/crypto.js`, `kdf.js`, `wrap.js`, `vault.js`, the
threat model in `SECURITY.md`, and the extension model in `extension/README.md`.
Nothing in the vault is real data, so it can be shared freely.

**What you need to decide:** who reviews it, and whether that is a paid engagement.

### Someone to load the extension, desktop and mobile builds on real hardware

None of the three has ever run on real hardware. Not once. They are tested against
stubs and jsdom, which catches logic bugs and not the things that break in a
browser or on a device:

- The extension's Fill has never executed `chrome.scripting.executeScript` for
  real. Field detection on a real login page, shadow DOM, iframes and Chrome's own
  injection path are unverified.
- The desktop shell has never opened a window on Windows or macOS.
- The mobile client has never run on a phone, and its Capacitor project has never
  been built.

This is one afternoon of clicking, on a machine with Chrome and a phone. It is the
highest value per hour of anything on this list.

### Signing, notarisation and store accounts

`desktop/README.md` is blunt about this and it has not changed:

- An Apple Developer certificate to sign and notarise the macOS build.
- A Windows code signing certificate, or an MSIX for the Microsoft Store.
- Developer accounts and identity verification for the mobile stores.

All of it costs money and takes days of waiting. None of it is code.

---

## 2. Decisions only you can make

Each of these is an open item in `tasks.md` marked "You". I have left them open
rather than picking an answer, because each one changes what the product is.

| Decision | Why it is yours | What exists while you decide |
| --- | --- | --- |
| **Release sequence and first audience** | Internal, invited beta or public changes how much of section 1 is a blocker | Nothing depends on it yet |
| **Supported platforms** | Windows/macOS is assumed. **Linux desktop is explicitly undecided** and needs its own packaging decision | Desktop targets the three paths but nothing is packaged |
| **Hosted AI policy** | The plan wants label suggestions from a hosted model. That means plaintext leaving the device | Local rules only. No hosted path exists and none will until you say so |
| **Recovery tradeoff** | Does losing both password and recovery key mean permanent loss? | **No recovery exists at all** (see section 3) |
| **Domains, support address, security contact** | I cannot own a domain or answer mail | The site renders a placeholder contact |
| **Budget limits and account ownership** | Neon, Vercel, Cloudflare, Resend, PostHog, Stripe, stores, signing | Everything runs locally with no services |
| **Pricing** | Never set. `PLAN.md` says no prices appear until numbers exist | The pricing page says so honestly |
| **Import scope** | Which sources are supported, after synthetic fixtures | Keep, CSV and `otpauth://` work. Google Authenticator's QR-only export does not |
| **Legal review** | The privacy and terms pages are drafts until counsel reads them | Marked as drafts |
| **Go-live approval** | The whole thing | Not close |

**Do not send credentials in chat.** Add them in the provider's own settings and
tell me the names, not the values.

---

## 3. Code gaps that remain

Stated plainly, because "all features land" has a floor and these are below it.

### No recovery key, and the plan asks for one

`PLAN.md` section 4 specifies "printable recovery kit with a recovery key that
wraps the vault key". Nothing exists. I did not build it, and the honest reason is
that a recovery key is **a second permanent key to the vault**. Once it exists,
every guarantee of the form "a password you lose is a vault you lose" becomes
false, and the threat model changes shape: the file on disk now has two wraps, and
anyone who photographs a printed kit owns the vault forever with no way to rotate
it away, because a rotation only replaces the password wrap.

That is a security design decision, not an implementation detail, which is why it
is in section 2 rather than done. If you decide it should exist, the shape is:
generate 256 bits, wrap the vault key under it, print it once, and add a
`revokeRecovery()` that re-wraps under a fresh recovery key. Perhaps a day of work
once the decision is made.

### Passkey unlock is a stub

`wrap.js` says so in its header: `passkeyWrapped: null`, and nothing writes it.
WebAuthn PRF is the mechanism, and it is genuinely unbuildable here, because it
needs a real authenticator and a browser and cannot be tested in this sandbox at
all. It belongs with the real-hardware work in section 1.

### Sync has no scheduler

`npm run sync` runs one round. Nothing runs it on a timer, and `README.md` says so.
Cron, a systemd timer, or a line in the desktop shell's tray would all fix it. I
would want your answer on where it should live first, because a background process
that moves vault ciphertext is not something to add by assumption.

### The marketing site is missing the pages the plan commits to

`PLAN.md` section 9 lists a blog index, three posts, and a product page per
surface. What exists is home, product, security, pricing, about, docs, contact and
the three legal pages. There is no `/blog`.

I stopped rather than inventing content: three blog posts about a product nobody
can buy yet would be filler, and the plan's own rule is no invented claims. Say the
word and I will write them against what the product actually does.

### Accounts do not exist

One local vault, one sample password, no users table, no tenancy. This is a
deliberate boundary rather than an omission. `IMPLEMENTATION_REVIEW.md` says the
prototype is synthetic data only partly for this reason.

---

## 4. Documentation that is wrong

You told me not to update the documentation, so I have not. Every one of these is a
place where the documents and the code disagree, listed so it is a decision and not
an oversight.

| File | Says | Reality |
| --- | --- | --- |
| `DEPLOYMENT.txt` | extension, desktop and mobile "are not implemented" | All three exist |
| `DEPLOYMENT.txt` | the server "binds to 0.0.0.0" | Defaults to `127.0.0.1`; `HASP_HOST` opts in |
| `DEPLOYMENT.txt` | "no accounts or sync" | Sync is built (PRs #8 to #26) |
| `tasks.md` | Phase 1: "no sync, no conflict handling, no offline" | All three built |
| `tasks.md` | Phase 0: "CI does not [exist]" | `.github/workflows/test.yml`, both Node versions |
| `tasks.md` | No mention of ~30 PRs of work | Restore, activity log, atomic writes, pairing, extension, desktop, rotation are all untracked there |
| `CONTRIBUTING.md` | "217 cases", and later "All 211" | 537 |
| `desktop/README.md` | the preload "exposes one function and one subscription" | Five keys |
| `README.md` | link to `#the-four-surfaces` | No such heading, so the link is dead |
| `SECURITY.md` | "No key rotation, not implemented" | Implemented in PR #33 |
| `PLAN.md` | a full architecture for a hosted service | Its own header says it is historical, so this one is disclosed rather than wrong |

`README.md` and `SECURITY.md` test counts are the two I keep current, because a
count that is wrong is a count nobody trusts.

---

## 5. What was built while this file sat uncommitted

So the state of things is not a mystery:

- **Extension Fill** (PR #32, merged). Fills a field on your click, refused on the
  vault page, refused on hidden fields, twenty-second window. Wrote the threat
  model the service worker said had to exist first. Three real bugs found by
  testing it, one of which would have filled an API key into the master password
  box.
- **Master password rotation** (PR #33, merged). Re-wraps the vault key under a new
  salt, touches no item, re-checks the current password, logged as `rotated`. It
  uncovered a worse bug: a successful password change made the server unable to
  start, because boot only ever tried the sample password. It now starts locked and
  opens with the real one.

Both are the kind of gap that only shows up when someone uses the feature, which is
the argument for section 1 more than anything I can write here.

---

## 6. Environment variables, and the one bug in them

You need **no keys** to run this. `npm install && npm start` works with an empty
environment. `keyFromEnv({})` returns `""` and the logo proxy reports
`not_configured`, falling back to the 586 vendored marks. Sync tokens and pairing
secrets are generated, never supplied.

| Variable | Required | Read by |
| --- | --- | --- |
| `LOGO_DEV_KEY` | No | `src/core/logodev.js`, the `/api/logo` proxy |
| `LOGO_DEV_PUBLIC_KEY` | No, and unused | `src/core/logodev.js` |
| `HASP_PASSWORD` | Only for `npm run sync` | `tools/sync.mjs`. Must be exported in the shell; it is deliberately not accepted on the command line |
| `HASP_VAULT_DIR` | No | `server.mjs` |
| `HASP_HOST` | No | `server.mjs`. `0.0.0.0` is needed to pair a phone |
| `HASP_EPHEMERAL` | No | `server.mjs`. `1` writes no vault file |
| `PORT` | No | `server.mjs`, overridden by `--port=` |

**The bug:** `server.mjs` reads `HASP_VAULT_DIR` and `PORT` at line 53 and 66, but
calls `loadEnv()` at line 69, so **a value in `.env` is silently ignored for both**.
Verified: with `HASP_VAULT_DIR` in `.env`, the server seeded `./.vault` and said
nothing. `LOGODEV`-style values set in `.env` do work, because they are read later.
This is a one-line move of the `loadEnv()` call, and it is not yet fixed.

**For the hosted product later:** `IMPLEMENTATION_REVIEW.md` names the accounts,
Neon, Vercel, Cloudflare, Resend, PostHog, Stripe, 9Router. None of that code
exists, so none of those keys are needed or asked for. When it does, they go in
Vercel's environment settings, never in this repository.

---

## If you read only one line

Load the extension in a real Chrome and change a password on a real vault. Those
two actions test two thirds of the work in the last two PRs, and neither has been
done by a human yet.
