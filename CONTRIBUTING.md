# Working on Hasp

Small project, few rules, and the rules that exist are the ones that have already
caught something.

## Setup

```
npm install
npm start        # http://localhost:3000, sample password foundry-nightshift-2026
npm test         # 217 cases
```

Node 22 or newer. No database, no environment variables, no network at runtime.

`npm run icons` regenerates `src/web/icons.js` from the vendored Heroicons set.
`npm run render` regenerates every image in `docs/screens`. Both are checked in, so
you only run them when you change the thing they generate.

## The rules

**Never commit a credential-shaped string, even a fake one.** GitHub's secret
scanning rejects the push, and it is right to. Sample values are worded as examples
(`EXAMPLE-stripe-live-sample-0000`), and tests that need a key the parser will
recognise build it from the shape table at run time rather than pasting it. If you
need a new fixture, do that.

**Describe what was observed, not what was intended.** A commit message here says
what was wrong, what broke when it was fixed, and what would have caught it. "Fix
bug" is not a commit message; the next person has to read the diff to find out what
happened, which is the work the message was supposed to save.

**Tests pin behaviour, not implementation.** The UI tests drive the real client
against the real server. If a test would still pass with the feature deleted, it is
not testing the feature.

**Do not claim stronger crypto than is implemented.** `src/core/crypto.js` and
`kdf.js` carry headers describing exactly what they do. If you change them, change
the header in the same commit.

**The contrast floor is a test, not a promise.** `test/theme.test.mjs` parses
`tokens.css` and fails below WCAG AA. Fix the token, not the test.

## Where things are

| Path | What lives there |
| --- | --- |
| `server.mjs` | the whole HTTP surface, one file, no dependencies |
| `src/core/` | crypto, vault, TOTP, parsers, sessions, throttle |
| `src/web/` | the client, tokens, components, vendored assets |
| `test/` | one file per concern; `ui.test.mjs` is the integration suite |
| `tools/` | generators for icons, the mark, the screenshots |

## Adding an icon

Add the Heroicons name to the `SET` map in `tools/icons.mjs`, copy the glyph into
`src/web/heroicons/`, run `npm run icons`. The identity test fails if the vendored
count and the generated file disagree, so a missing copy is caught rather than
silently dropped.

## Before you open a pull request

```
npm test
```

All 211. If you changed anything visual, run `npm run render` and look at the
output; the renderer is the only way to see the result in an environment without a
browser.
