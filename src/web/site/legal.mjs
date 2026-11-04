// Legal pages.
//
// These are written from what the software actually does, which is the only part of
// a legal page an engineer is qualified to write. Every clause that depends on a
// business decision carries a DRAFT marker: no lawyer has reviewed this, there is
// no company entity behind it yet, and inventing a jurisdiction, a retention
// period or a data controller would be worse than admitting the gap.
//
// The markers are for review. A page that ships with them is honest; a page that
// ships without them and without a review is not.

import { page } from "./layout.mjs";

const UPDATED = "4 November 2026";

const draft = (text) => `<span class="draft">Draft</span>${text}`;

export const privacy = () =>
  page({
    path: "/privacy",
    title: "Privacy · Hasp",
    description:
      "What data Hasp processes, where it is stored, and what leaves the machine. The short version: nothing leaves it.",
    body: `
<div class="doc"><div class="wrap measure">
  <h1>Privacy</h1>
  <p class="updated">Last updated ${UPDATED}</p>

  <p style="margin-top:24px">${draft("This policy describes the software in this repository. It has not been reviewed by a lawyer, and no company entity operates a hosted service behind it.")}</p>

  <h2>What Hasp processes</h2>
  <p>Hasp stores the items you add: names, services, hosts, environments, notes, secret values, one-time code secrets and backup code sets. It also stores the parameters used to derive your key, and the wrapped vault key.</p>
  <p>It does not collect analytics, telemetry, usage events, device identifiers or crash reports. There is no account and no email address.</p>

  <h2>Where the data goes</h2>
  <p>Nowhere. The vault is a single encrypted file at <code>.vault/vault.json</code> in the directory you ran it from, unless you set <code>HASP_EPHEMERAL=1</code>, in which case nothing is written to disk at all.</p>
  <p>The interface is served by the same process that holds the key. That process makes no outbound request at runtime. Company marks, fonts and icons are served from the project folder rather than a CDN.</p>

  <h2>What the server can see</h2>
  <p>${draft("This is the important limitation, and it is a property of the current architecture rather than a policy choice.")} The server derives your key and seals items, which means plaintext passes through the Node process and over the loopback interface. Anyone who can read that process's memory can read the vault key. A future version is intended to move this work into the browser, which would change this paragraph.</p>

  <h2>Third parties</h2>
  <p>None are contacted by the software. ${draft("If a hosted version is ever operated, this section will need the hosting provider, the region, the sub-processors and the lawful basis for each. None of those decisions exists yet.")}</p>

  <h2>Your rights</h2>
  <p>${draft("A hosted service would owe you access, correction, deletion and portability. Because there is no service and no account, the practical answer is that the file is yours: delete it and the data is gone. Export is available from the Settings screen.")}</p>

  <h2>Retention</h2>
  <p>${draft("No retention period is defined because there is no service retaining anything. The file persists until you delete it.")}</p>

  <h2>Contact</h2>
  <p><a href="mailto:hello@hasp.dev">hello@hasp.dev</a></p>
</div></div>
`,
  });

export const terms = () =>
  page({
    path: "/terms",
    title: "Terms · Hasp",
    description:
      "The terms for using Hasp. It is provided as-is, without warranty, during development.",
    body: `
<div class="doc"><div class="wrap measure">
  <h1>Terms</h1>
  <p class="updated">Last updated ${UPDATED}</p>

  <p style="margin-top:24px">${draft("These terms describe software provided as-is during development. They have not been reviewed by a lawyer and no company entity is named as the counterparty.")}</p>

  <h2>What you are using</h2>
  <p>Hasp is software you run yourself. It is not a service, and no hosted instance is offered by this project.</p>

  <h2>No warranty</h2>
  <p>The software is provided without warranty of any kind. It has not received an independent security review. Its cipher and parameters are documented in the repository, and its known limitations are listed on the <a href="/security">security page</a>. Do not use it for secrets whose loss you cannot accept.</p>

  <h2>Your responsibility</h2>
  <p>You control the machine it runs on, the password that opens the vault, and any copy of the vault file. If you lose the password the vault cannot be recovered. If you copy the file to an untrusted machine, that machine can attack it offline.</p>

  <h2>Licence</h2>
  <p>The code is MIT licensed. Vendored assets keep their own licences, listed in the repository: Heroicons is MIT, and company marks belong to their owners.</p>

  <h2>Liability</h2>
  <p>${draft("A limitation of liability clause, a governing jurisdiction and a definition of the contracting party are all business decisions. None has been made, so this section is not drafted rather than drafted badly.")}</p>

  <h2>Changes</h2>
  <p>${draft("How changes to these terms would be announced depends on whether a hosted service exists. Today the repository's history is the record.")}</p>

  <h2>Contact</h2>
  <p><a href="mailto:hello@hasp.dev">hello@hasp.dev</a></p>
</div></div>
`,
  });

export const cookies = () =>
  page({
    path: "/cookies",
    title: "Cookies · Hasp",
    description:
      "Hasp sets one cookie, to hold your unlocked session. There are no tracking cookies and no consent banner is needed.",
    body: `
<div class="doc"><div class="wrap measure">
  <h1>Cookies</h1>
  <p class="updated">Last updated ${UPDATED}</p>

  <h2>One cookie</h2>
  <p>When you unlock the vault, the server sets a session cookie. It is <code>HttpOnly</code>, <code>SameSite=Strict</code>, scoped to the path, and it expires with the session.</p>
  <p>It holds a random session identifier and nothing else. The vault key stays in the server's memory and is never written into the cookie.</p>

  <h2>Nothing else</h2>
  <p>There are no analytics cookies, no advertising cookies, no third-party cookies and no localStorage identifiers used for tracking. Appearance settings are stored in <code>localStorage</code> on your device and are never transmitted.</p>

  <h2>Why there is no banner</h2>
  <p>A consent banner is required for non-essential cookies. The session cookie is strictly necessary to keep the vault open, and nothing else is set, so there is nothing to consent to. If that changes, this page changes first.</p>

  <h2>Removing it</h2>
  <p>Locking the vault clears the cookie. Clearing your browser's site data does the same. Neither deletes the vault file.</p>
</div></div>
`,
  });

export const notFound = () =>
  page({
    path: "/404",
    title: "Page not found · Hasp",
    description: "That page does not exist. Links to the main pages are below.",
    body: `
<section class="hero">
  <div class="wrap">
    <p class="eyebrow">404</p>
    <h1>That page does not exist.</h1>
    <p class="lede">The link may be old, or the address may have a typo.</p>
    <div class="hero-actions">
      <a class="btn" href="/">Go to the homepage</a>
      <a class="btn btn--quiet" href="/docs">Read the documentation</a>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap">
    <h2>Everything else</h2>
    <dl class="list">
      <div><dt><a href="/product">Product</a></dt><dd>What Hasp does, and does not do.</dd></div>
      <div><dt><a href="/security">Security</a></dt><dd>Guarantees, gaps and the threat model.</dd></div>
      <div><dt><a href="/docs">Documentation</a></dt><dd>Run it, import your exports, learn the keys.</dd></div>
      <div><dt><a href="/app">Demonstration</a></dt><dd>The vault itself, with sample data.</dd></div>
    </dl>
  </div>
</section>
`,
  });
