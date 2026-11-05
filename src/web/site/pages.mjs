// The public pages.
//
// Copy rules this file follows, from the brief: specific claims, no invented
// reviews or metrics, no em dashes, active voice, and a limitation stated next to
// the thing it limits rather than hidden in a footnote.

import { page, SAMPLE_NOTE } from "./layout.mjs";

const UPDATED = "4 November 2026";

// --------------------------------------------------------------------- home

export const home = () =>
  page({
    path: "/",
    title: "Hasp · A local-first vault for the keys you actually use",
    description:
      "Hasp keeps API keys, backup codes and one-time codes in one encrypted vault on your own machine. No account, no hosted service, no request unless you sync.",
    body: `
<section class="hero">
  <div class="wrap">
    <h1>The keys you actually use, in one sealed place.</h1>
    <p class="lede">API keys, backup codes and one-time codes in a single encrypted vault.
      It runs on your machine and needs no account. Your secrets never leave the disk you chose.</p>
    <div class="hero-actions">
      <a class="btn" href="/app">Open the demonstration</a>
      <a class="btn btn--quiet" href="/product">How it works</a>
    </div>
  </div>
</section>

<div class="wrap">
  <dl class="facts">
    <div><dt>Runs on</dt><dd>Your machine, as one Node process</dd></div>
    <div><dt>Network at runtime</dt><dd>None. Every asset is local</dd></div>
    <div><dt>Cipher</dt><dd>ChaCha20-Poly1305, 12 byte nonce</dd></div>
  </dl>
</div>

<section class="section">
  <div class="wrap split">
    <div>
      <p class="eyebrow">The problem</p>
      <h2>Your keys are scattered across five tools.</h2>
      <p class="body">A note in Keep. A text file on the desktop. Three browser tabs you
        reopened from history. A codes app on the phone that no longer matches the one on
        the laptop.</p>
      <p class="body">Hasp puts them in one list you can search, label by environment, and
        open with a single password.</p>
    </div>
    <div>
      <img class="shot" src="/screens/nightshift-dark.png"
        alt="The Hasp vault in Nightshift dark mode, showing a list of API keys with an inspector pane showing a masked secret and a live one-time code."
        width="1280" height="820" loading="lazy" decoding="async">
      <p class="shot-caption">Nightshift, the default surface. Drawn from the real tokens and typefaces.</p>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <p class="eyebrow">What it does</p>
    <h2>Four things, and it does them properly.</h2>
    <dl class="list">
      <div><dt>Stores keys</dt><dd>Each item is sealed under its own key, bound to its
        position, so a ciphertext moved to another row fails to open instead of opening as
        something else.</dd></div>
      <div><dt>Generates codes</dt><dd>RFC 6238 one-time codes with a depletion bar, checked
        against the RFC's own test vectors.</dd></div>
      <div><dt>Tracks backup codes</dt><dd>Code sets keep an unused count. There is no copy-all
        button, because copying a set is how sets end up in a chat log.</dd></div>
      <div><dt>Imports your exports</dt><dd>Google Keep JSON and HTML, CSV, otpauth URIs, and
        the JSON dialects of six authenticator apps. Every field carries a confidence score,
        and anything uncertain goes to review.</dd></div>
    </dl>
  </div>
</section>

<section class="section">
  <div class="wrap split">
    <div>
      <p class="eyebrow">Local first</p>
      <h2>Nothing leaves the machine.</h2>
      <p class="body">There is no server to trust. The vault is one encrypted file. The
        interface is served by the same process that holds the key, and the process makes
        no outbound request at runtime.</p>
      <p class="body">Sync is off until you turn it on, and it is a file on your own
        machine rather than a service. When it is on, two devices exchange the same
        ciphertext the vault already holds. Nothing is readable in transit, because
        nothing readable is ever sent.</p>
      <p class="body">There is still no account recovery and no sharing. Both need a party
        that can hold something for you, and this product has none.</p>
    </div>
    <div>
      ${SAMPLE_NOTE}
      <dl class="list" style="margin-top:24px">
        <div><dt>Dependencies at runtime</dt><dd>None. One Node process and a folder.</dd></div>
        <div><dt>Assets</dt><dd>586 company marks, nine font files and 25 icons, all vendored.</dd></div>
        <div><dt>Works offline</dt><dd>Fully, after the first load.</dd></div>
      </dl>
    </div>
  </div>
</section>
`,
  });

// ------------------------------------------------------------------ product

export const product = () =>
  page({
    path: "/product",
    title: "Product · Hasp",
    description:
      "What Hasp does: an encrypted vault, one-time codes, backup code sets, import with review, and two design directions with light and dark modes.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">Product</p>
    <h1>One list, sealed with one password.</h1>
    <p class="lede">Hasp is a web application that runs on your machine. It holds keys,
      codes and notes, and it does not contact anything.</p>
    <div class="hero-actions"><a class="btn" href="/app">Open the demonstration</a></div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>The vault</h2>
    <p class="body">A list with a search field, a type filter and an environment filter.
      Selecting a row opens an inspector: the masked secret, its metadata, and the actions
      that apply to that item.</p>
    <dl class="list">
      <div><dt>Create and edit</dt><dd>Name, service, host, type, environment, value and notes.</dd></div>
      <div><dt>Reveal</dt><dd>Secrets stay masked until asked. Revealing is per item and per session.</dd></div>
      <div><dt>Copy</dt><dd>The clipboard clears after 30 seconds, and the timer is cancelled when the vault locks.</dd></div>
      <div><dt>Rotate</dt><dd>Replacing a value keeps the previous version, so a rotation is reversible.</dd></div>
      <div><dt>Search</dt><dd>Queries match a blind index built from keyed hashes, so the vault never stores the words you searched for.</dd></div>
      <div><dt>Sync</dt><dd>Off by default. Two of your own devices exchange records that are already
        ciphertext. The store sees the vault id, the record id, a revision, timestamps, the
        item type and the blind index. It cannot read a name or a value, because it holds no key.</dd></div>
    </dl>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>Two directions, four surfaces</h2>
    <p class="body">Direction and mode are independent choices, and the accent is a third
      axis. That is four surfaces with one set of components, and the contrast floor is
      checked per combination by the test suite.</p>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:28px">
      <div>
        <img class="shot" src="/screens/nightshift-light.png" alt="Nightshift light mode" width="1280" height="820" loading="lazy">
        <p class="shot-caption">Nightshift, light</p>
      </div>
      <div>
        <img class="shot" src="/screens/foundry-dark.png" alt="Foundry dark mode" width="1280" height="820" loading="lazy">
        <p class="shot-caption">Foundry, dark</p>
      </div>
    </div>
    <p class="body" style="margin-top:20px">Nightshift is neumorphic: controls sit in the
      surface instead of on top of it, drawn with a paired light and dark shadow and no
      visible borders. Foundry is structural: square corners, one pixel rules, and a solid
      header. Both support black, white and neutral accent styles.</p>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>Import with review</h2>
    <p class="body">Drop an export in and Hasp parses it into candidates, each with a
      confidence score. You review before anything is stored, and a parsed import is single
      use and expires after 30 minutes.</p>
    <dl class="list">
      <div><dt>Notes</dt><dd>Google Keep JSON and HTML.</dd></div>
      <div><dt>Tables</dt><dd>CSV with header detection.</dd></div>
      <div><dt>Codes</dt><dd>otpauth URIs, and the exports of Aegis, 2FAS, Raivo, Bitwarden, Google Authenticator and Microsoft Authenticator.</dd></div>
    </dl>
  </div>
</section>
`,
  });

// ----------------------------------------------------------------- security

export const security = () =>
  page({
    path: "/security",
    title: "Security · Hasp",
    description:
      "What Hasp guarantees, what it does not, and the threat model. Tested, not audited. The cipher and its parameters are stated exactly.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">Security</p>
    <h1>Tested, not audited.</h1>
    <p class="lede">That is the honest summary. This page states the guarantees, the gaps,
      and the threat model, and it names the test that fails if a guarantee is removed.</p>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>What is guaranteed</h2>
    <dl class="list">
      <div><dt>The password is never stored</dt><dd>It derives a key with scrypt, and that key unwraps a random vault key. Only the wrapped key reaches disk.</dd></div>
      <div><dt>Ciphertext is bound to its position</dt><dd>Associated data covers the vault id, the item id and the version. A moved or rolled-back ciphertext fails to open.</dd></div>
      <div><dt>Wrong password is indistinguishable from a corrupt vault</dt><dd>Both fail at the unwrap with the same error.</dd></div>
      <div><dt>Nothing is written in plaintext</dt><dd>The vault file is checked after every write for values that should only exist encrypted.</dd></div>
      <div><dt>Guessing is bounded</dt><dd>Three free attempts, then a doubling wait to a two minute ceiling. A correct password is refused while the wait runs, so the throttle is not an oracle.</dd></div>
      <div><dt>The browser is constrained</dt><dd>HttpOnly, SameSite=Strict cookies. Cross-origin posts refused. CSP default-src self, with one inline script allowed by hash.</dd></div>
    </dl>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>What is not</h2>
    <dl class="list">
      <div><dt>No independent review</dt><dd>The cryptography has not been audited. Tests find the bugs someone thought to test for.</dd></div>
      <div><dt>Not XChaCha20</dt><dd>The cipher is ChaCha20-Poly1305 with a 12 byte nonce, not the XChaCha20-Poly1305 the plan specifies.</dd></div>
      <div><dt>Server-side cryptography</dt><dd>Derivation and sealing happen in the Node process, and plaintext crosses the loopback interface. This is not a client-side encryption architecture.</dd></div>
      <div><dt>No transport security</dt><dd>Hasp serves plain HTTP. Put it behind TLS or bind it to loopback.</dd></div>
      <div><dt>No defence against a compromised host</dt><dd>If something can read the process memory, it can read the vault key.</dd></div>
      <div><dt>No key rotation</dt><dd>Changing the master password is not implemented.</dd></div>
    </dl>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>Threat model</h2>
    <p class="body"><strong>In scope.</strong> Someone with the vault file but not the
      password. Someone sending requests to a running instance. A stolen device left
      unlocked, where the idle lock is a speed bump rather than a wall.</p>
    <p class="body"><strong>Out of scope.</strong> Malware on the machine, a compromised
      browser, a keylogger, and the operator. A local web app cannot solve those, and
      claiming otherwise would be the dishonest part of a security page.</p>
    <p class="body"><a href="/contact">Report a vulnerability</a> privately. Do not open a
      public issue.</p>
  </div>
</section>
`,
  });

// ------------------------------------------------------------------ pricing

export const pricing = () =>
  page({
    path: "/pricing",
    title: "Pricing · Hasp",
    description:
      "Hasp is free while it is in development. There is no paid tier, no billing system and no price list, because none has been decided.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">Pricing</p>
    <h1>Free while it is in development.</h1>
    <p class="lede">There is no paid tier and no billing system. A price list would be a
      claim about a product that does not have one yet, so this page does not invent one.</p>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>What that means</h2>
    <dl class="list">
      <div><dt>Cost today</dt><dd>Nothing. Run it from source.</dd></div>
      <div><dt>Accounts</dt><dd>None exist, so there is nothing to bill against.</dd></div>
      <div><dt>Hosting</dt><dd>You host it, if you choose to. Hasp makes no hosted service available.</dd></div>
      <div><dt>Future pricing</dt><dd>Undecided. When there is a number it will appear here, in this list.</dd></div>
    </dl>
    <p class="body" style="margin-top:26px">If you need the key management features today, the
      demonstration is complete and free. Sync is included and is a file you run yourself.
      If you need sharing, a hosted service or account recovery, Hasp does not offer them.</p>
  </div>
</section>
`,
  });

// -------------------------------------------------------------------- about

export const about = () =>
  page({
    path: "/about",
    title: "About · Hasp",
    description:
      "Why Hasp exists, what it is built from, and what is deliberately left out. A small local-first tool, not a platform.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">About</p>
    <h1>A small tool for one job.</h1>
    <p class="lede">Hasp began as a way to stop keeping API keys in a note-taking app. It
      stayed small on purpose.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>Why it exists</h2>
    <p class="body">API keys accumulate. Each one is generated in a console, pasted into a
      note, and forgotten until it appears in a log. The tool that should hold them is a
      password manager, but those are built for passwords: they do not track which
      environment a key belongs to, when it rotates, or which one a test suite should use.</p>
    <p class="body">Hasp is a vault that understands keys as items with metadata: a service,
      a host, an environment, an owner and a rotation habit.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>What it is built from</h2>
    <p class="body">One Node process and a folder. The client has no runtime dependencies
      and no CDN. Icons are Heroicons solid, vendored with their licence. The 586 company
      marks come from Simple Icons and SVG Logos, vendored so the app works offline. The
      three typefaces are served from the project.</p>
    <p class="body">The design system is four token combinations for two directions and two
      modes, plus three accent styles. The contrast floor is a test, not a promise, and it
      parses the stylesheet to enforce it.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>What is deliberately missing</h2>
    <p class="body">Accounts, sharing, account recovery and a hosted service. Each needs a
      company holding something on your behalf, and that is the thing this product is
      built to avoid.</p>
    <p class="body">Sync exists and is off by default. It moves ciphertext between your own
      machines over your own network. It is not a service, there is nothing to sign up
      for, and it stores no plaintext, because it has no key to read any.</p>
  </div>
</section>
`,
  });

// --------------------------------------------------------------------- docs

export const docs = () =>
  page({
    path: "/docs",
    title: "Documentation · Hasp",
    description:
      "Run Hasp, unlock the sample vault, import an export, and understand the keyboard shortcuts. Requires Node 22 or newer.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">Documentation</p>
    <h1>Run it in two commands.</h1>
    <p class="lede">Hasp needs Node 22 or newer. There is no database, no environment
      variable and no network access at runtime.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>Start</h2>
    <pre style="font-family:var(--mono);font-size:13px;background:var(--paper-2);border:1px solid var(--rule);padding:16px;overflow-x:auto;margin-top:16px">npm install
npm start</pre>
    <p class="body">Then open <code>http://localhost:3000</code>. The sample master password
      is <code>foundry-nightshift-2026</code> and it is filled in for you.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>Import your exports</h2>
    <p class="body">Open Imports, then drop a file or paste text. Hasp detects the format:
      Google Keep JSON or HTML, CSV, otpauth URIs, and the JSON exports of Aegis, 2FAS,
      Raivo, Bitwarden, Google Authenticator and Microsoft Authenticator.</p>
    <p class="body">Every candidate carries a confidence score. Anything under 70 percent
      goes to review before it is stored. A parsed import can be accepted once, and it
      expires after 30 minutes.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>Two machines, one vault</h2>
    <p class="body">Sync is off until you turn it on. Open Settings and press
      <code>Turn sync on</code>. The panel shows a write token once, and only once,
      because the store keeps a hash of it rather than the token. A token you did not
      write down cannot be recovered, only rotated.</p>
    <p class="body">On the second machine, run one command with that token:</p>
    <pre style="font-family:var(--mono);font-size:13px;background:var(--paper-2);border:1px solid var(--rule);padding:16px;overflow-x:auto;margin-top:16px">HASP_PASSWORD=... npm run sync -- \
  --vault ~/.hasp/vault.json \
  --url http://192.168.1.20:3000 \
  --vault-id VAULT-ID --token TOKEN</pre>
    <p class="body">It reads the master password from the environment rather than a flag,
      because a shell history outlives the command. It asks only for what changed since
      this machine's last sequence number, proves every record by opening it under this
      vault's key, and writes the file back only when something landed. A record it cannot
      open is counted, left out, and the run exits non-zero.</p>
    <p class="body">Nothing schedules that command. If you want two machines kept level,
      run it or put it in cron. A machine that has never held the vault file cannot start,
      because sync moves ciphertext between copies of one vault and does not create the
      first one.</p>
    <p class="body">Everything in flight is a record the vault already stores encrypted.
      The store sees the vault id, the record id, a revision, timestamps, the item type
      and the blind index. It cannot read a name, a note or a value.</p>
    <p class="body">When two machines change the same item from the same starting point,
      both reach the same revision with different ciphertext. The store refuses the second
      and reports it. Nothing is merged, because the store can read neither side.</p>
    <p class="body">Settings lists each clash with a comparison: both copies decrypted,
      field by field, and a button for each. Keeping one raises its revision above the one
      that lost and sends it out, so the next round is quiet. There is no three way merge
      and no way to keep half of each. That comparison is the only route that returns a
      plaintext value from the store's copy, and it can only do so because the process
      running it holds the vault key.</p>
    <p class="body">The routes, if you would rather script it. <code>POST /api/sync/start</code>,
      <code>GET /api/sync/status</code>, <code>POST /api/sync/round</code>,
      <code>POST /api/sync/pull</code>, <code>GET /api/sync/conflicts</code>,
      <code>GET /api/sync/conflicts/compare</code>, <code>POST /api/sync/conflicts/resolve</code>
      and <code>DELETE /api/sync/pairing</code>.</p>
    </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>Keys worth knowing</h2>
    <dl class="list">
      <div><dt>Search</dt><dd><code>/</code> or <code>Cmd K</code> focuses the search field.</dd></div>
      <div><dt>Escape</dt><dd>Closes the editor, or leaves the walkthrough.</dd></div>
      <div><dt>Unlock</dt><dd>The field takes focus on load, so you can type immediately.</dd></div>
    </dl>
  </div>
</section>
`,
  });

// ------------------------------------------------------------------ contact

export const contact = () =>
  page({
    path: "/contact",
    title: "Contact · Hasp",
    description: "How to reach the Hasp project, including the private route for security reports.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">Contact</p>
    <h1>Write to a person.</h1>
    <p class="lede">One address, read by the person who builds it.</p>
  </div>
</section>

<section class="section">
  <div class="wrap measure">
    <h2>General</h2>
    <p class="body"><a href="mailto:hello@hasp.dev">hello@hasp.dev</a></p>
    <p class="body">Expect a reply within a week. This is a small project and that is the
      honest timeframe.</p>

    <h2 style="margin-top:44px">Security</h2>
    <p class="body">Report a vulnerability through the repository's private security
      advisory, not a public issue. If the report involves a leaked credential, rotate it
      first.</p>

    <h2 style="margin-top:44px">What is not offered</h2>
    <p class="body">There is no hosted service, no support contract and no account to
      recover. If you lose the master password, the vault cannot be opened. That is the
      design, not an oversight.</p>
  </div>
</section>
`,
  });
