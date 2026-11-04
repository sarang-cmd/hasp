// Tests for the seam between the authenticator parsers and the vault.
//
// The interesting cases are the ones where a naive conversion produces something
// that looks fine and is wrong: a code that lands in the vault with no company
// name, an HOTP account that can never produce a code, a secret short enough to be
// a typo.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  accountToCandidate,
  authImportToCandidates,
  looksLikeAuthenticator,
} from "../src/core/authimport.js";
import { parseAuthenticatorExport } from "../src/core/authenticator.js";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const acct = (over = {}) => ({
  kind: "totp",
  name: "GitHub",
  issuer: "GitHub",
  account: "you@example.com",
  secret: SECRET,
  digits: 6,
  period: 30,
  algorithm: "SHA1",
  ...over,
});

describe("account to candidate", () => {
  test("a known issuer becomes a brand and a host", () => {
    const c = accountToCandidate(acct());
    assert.equal(c.brand, "github");
    assert.equal(c.host, "github.com");
    assert.equal(c.type, "totp");
    assert.equal(c.totp.secret, SECRET);
    assert.equal(c.needsReview, false);
  });

  test("every candidate carries an id, since the review compares ids", () => {
    const a = accountToCandidate(acct());
    const b = accountToCandidate(acct());
    assert.ok(a.id, "no id");
    assert.notEqual(a.id, b.id, "two candidates shared an id");
  });

  test("the account name goes in the title and the notes", () => {
    const c = accountToCandidate(acct());
    assert.match(c.name, /GitHub/);
    assert.match(c.name, /you@example\.com/);
    assert.match(c.notes, /Account: you@example\.com/);
  });

  test("an issuer with no brand still names the item", () => {
    const c = accountToCandidate(acct({ issuer: "Some Internal Tool", name: "Some Internal Tool" }));
    assert.equal(c.brand, "");
    assert.equal(c.host, "");
    assert.equal(c.service, "Some Internal Tool");
    assert.equal(c.needsReview, false, "an unknown company is not a reason to distrust the secret");
  });

  test("a short secret is flagged rather than imported quietly", () => {
    const c = accountToCandidate(acct({ secret: "JBSWY3DP" }));
    assert.equal(c.needsReview, true);
    assert.match(c.reviewReasons.join(" "), /bytes/);
  });

  test("a missing issuer is flagged, since the item would be nameless", () => {
    const c = accountToCandidate(acct({ issuer: "", name: "", account: "you@example.com" }));
    assert.equal(c.needsReview, true);
    assert.match(c.reviewReasons.join(" "), /no issuer/);
  });

  test("hotp is flagged because a counter is needed", () => {
    const c = accountToCandidate(acct({ kind: "hotp", counter: 4 }));
    assert.equal(c.needsReview, true);
    assert.equal(c.totp.counter, 4);
    assert.match(c.reviewReasons.join(" "), /counter/);
  });

  test("an account whose name equals the issuer is not repeated", () => {
    const c = accountToCandidate(acct({ issuer: "GitHub", account: "GitHub" }));
    assert.equal(c.name, "GitHub");
  });

  test("the import source is recorded in the notes", () => {
    const c = accountToCandidate(acct(), { origin: "2FAS" });
    assert.match(c.notes, /Imported from 2FAS/);
  });
});

describe("whole import", () => {
  test("an otpauth paste converts end to end", () => {
    const result = parseAuthenticatorExport(
      "otpauth://totp/GitHub:you%40example.com?secret=" + SECRET + "&issuer=GitHub",
    );
    const out = authImportToCandidates(result);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].brand, "github");
    assert.match(out.summary, /1 one-time code/);
    assert.match(out.summary, /otpauth URIs/);
  });

  test("a 2FAS export converts, and its skipped entries survive", () => {
    const json = JSON.stringify({
      services: [
        { name: "GitHub", secret: SECRET, otp: { issuer: "GitHub", account: "you@example.com" } },
        { name: "Broken", secret: "!!!" },
      ],
    });
    const out = authImportToCandidates(parseAuthenticatorExport(json));
    assert.equal(out.candidates.length, 1);
    assert.equal(out.skipped.length, 1);
    assert.match(out.summary, /1 skipped/);
  });

  test("a parse error comes back as an empty import with the reason", () => {
    const out = authImportToCandidates({ accounts: [], skipped: [], error: "Not valid JSON" });
    assert.equal(out.candidates.length, 0);
    assert.equal(out.summary, "Not valid JSON");
  });

  test("nothing at all does not throw", () => {
    const out = authImportToCandidates(null);
    assert.deepEqual(out.candidates, []);
    assert.ok(out.summary);
  });

  test("the flagged count appears in the summary", () => {
    const result = { accounts: [acct(), acct({ secret: "JBSWY3DP" })], skipped: [], source: "Raivo" };
    assert.match(authImportToCandidates(result).summary, /1 need review/);
  });

  test("every candidate carries the imported tag", () => {
    const out = authImportToCandidates({ accounts: [acct()], skipped: [], source: "Raivo" });
    assert.deepEqual(out.candidates[0].tags, ["imported"]);
  });
});

describe("detection", () => {
  test("recognises each dialect the parser supports", () => {
    const cases = {
      otpauth: "otpauth://totp/x?secret=" + SECRET,
      fas2: '{"services":[]}',
      aegis: '{"db":{"entries":[]}}',
      google: '{"otp_parameters":[]}',
      microsoft: '{"AuthenticatorAccounts":[]}',
      bitwarden: '{"items":[{"login":{"totp":"x"}}]}',
      raivo: '[{"issuer":"GitHub","secret":"' + SECRET + '"}]',
    };
    for (const [name, text] of Object.entries(cases)) {
      assert.ok(looksLikeAuthenticator(text), `${name} was not recognised`);
    }
  });

  test("leaves a Keep export and a CSV to the other parser", () => {
    assert.equal(looksLikeAuthenticator('{"notes":[{"title":"a","textContent":"b"}]}'), false);
    assert.equal(looksLikeAuthenticator("name,url,username,password\nGroq,https://groq.com,u,p"), false);
    assert.equal(looksLikeAuthenticator("just a pasted note about keys"), false);
  });

  test("a bare array without secrets is not an authenticator export", () => {
    assert.equal(looksLikeAuthenticator('[{"a":1},{"b":2}]'), false);
  });

  test("malformed JSON is not claimed", () => {
    assert.equal(looksLikeAuthenticator('{"services":'), false);
  });
});
