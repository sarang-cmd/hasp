// Authenticator imports.
//
// Every fixture is invented. The secrets are filler base32 that decodes to the
// right byte length, not credentials from any account. The point of these tests is
// the dialect handling: a real export from each app has a shape, and guessing at a
// key name produces a silent zero instead of an error.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseSecret,
  parseOtpauth,
  parseOtpauthText,
  parseAuthenticatorJson,
  parseAuthenticatorExport,
  describeImport,
  secretStrength,
} from "../src/core/authenticator.js";

/** Valid base32 filler of a given decoded length. */
const filler = (bytes = 20) => "JBSWY3DPEHPK3PXP".repeat(2).slice(0, Math.ceil((bytes * 8) / 5));

describe("normaliseSecret", () => {
  test("uppercases, strips spaces and padding", () => {
    assert.equal(normaliseSecret("jbswy3dp ehpk3pxp"), "JBSWY3DPEHPK3PXP");
    assert.equal(normaliseSecret("JBSWY3DPEHPK3PXP===="), "JBSWY3DPEHPK3PXP");
    assert.equal(normaliseSecret("  jbsw-y3dp-ehpk-3pxp "), "JBSWY3DPEHPK3PXP");
  });

  test("rejects anything outside base32", () => {
    // 0, 1, 8 and 9 are not in the alphabet. A secret with one in it would
    // generate wrong codes forever rather than failing, so it is refused here.
    assert.equal(normaliseSecret("JB0WY3DPEHPK3PXP"), null);
    assert.equal(normaliseSecret("JB1WY3DP"), null);
    // "HELLOWORLD" is actually legal base32: H, E, W, O, R, L, D are all in the
    // alphabet. It is a weak secret, not an invalid one, so it normalises. The
    // strength check is secretStrength(), not this one.
    assert.equal(normaliseSecret("hello world"), "HELLOWORLD");
    assert.equal(normaliseSecret(""), null);
    assert.equal(normaliseSecret(null), null);
  });

  test("rejects a secret too short to be a key", () => {
    assert.equal(normaliseSecret("JBSWY"), null, "5 characters cannot hold a key");
    assert.ok(normaliseSecret("JBSWY3DP"));
  });
});

describe("parseOtpauth", () => {
  test("reads the standard form", () => {
    const a = parseOtpauth(`otpauth://totp/GitHub:me?secret=${filler(20)}&issuer=GitHub`);
    assert.equal(a.kind, "totp");
    assert.equal(a.issuer, "GitHub");
    assert.equal(a.account, "me");
    assert.equal(a.digits, 6);
    assert.equal(a.period, 30);
    assert.equal(a.algorithm, "SHA1");
  });

  test("honours digits, period and algorithm when they travel", () => {
    // This is the whole reason otpauth is the interchange format: a Google
    // Authenticator export with SHA256 and 8 digits must survive the round trip.
    const a = parseOtpauth(`otpauth://totp/Acme:bob?secret=${filler(32)}&digits=8&period=60&algorithm=SHA256`);
    assert.equal(a.digits, 8);
    assert.equal(a.period, 60);
    assert.equal(a.algorithm, "SHA256");
  });

  test("the issuer parameter wins over the label prefix", () => {
    // Apps disagree here; the parameter is the authoritative one.
    const a = parseOtpauth(`otpauth://totp/OldName:me?secret=${filler(20)}&issuer=NewName`);
    assert.equal(a.issuer, "NewName");
    assert.equal(a.account, "me");
  });

  test("a label with no colon is the account", () => {
    const a = parseOtpauth(`otpauth://totp/alice%40example.com?secret=${filler(20)}`);
    assert.equal(a.account, "alice@example.com");
    assert.equal(a.issuer, "alice@example.com");
  });

  test("hotp carries a counter", () => {
    const a = parseOtpauth(`otpauth://hotp/Acme:me?secret=${filler(20)}&counter=7`);
    assert.equal(a.kind, "hotp");
    assert.equal(a.counter, 7);
  });

  test("refuses what it cannot use, rather than importing a broken entry", () => {
    assert.equal(parseOtpauth("otpauth://totp/Acme?issuer=Acme"), null, "no secret");
    assert.equal(parseOtpauth(`otpauth://steam/Acme?secret=${filler(20)}`), null, "unknown type");
    assert.equal(parseOtpauth("not a uri"), null);
    assert.equal(parseOtpauth("https://example.com"), null);
  });
});

describe("parseOtpauthText", () => {
  test("finds every URI in a paste, in order", () => {
    const text = `first
      otpauth://totp/Acme:a?secret=${filler(20)}&issuer=Acme
      some notes from the export
      otpauth://totp/Beta:b?secret=${filler(20)}&issuer=Beta`;
    const found = parseOtpauthText(text);
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((a) => a.issuer), ["Acme", "Beta"]);
  });

  test("a paste with no URIs yields nothing, not a throw", () => {
    assert.deepEqual(parseOtpauthText("just some text"), []);
  });
});

describe("vendor dialects", () => {
  test("2FAS", () => {
    const json = JSON.stringify({
      schemaVersion: 3,
      services: [
        { name: "GitHub", secret: filler(20), otp: { issuer: "GitHub", account: "me", digits: 6, period: 30, algorithm: "SHA1" } },
        { name: "Acme", secret: filler(20), otp: { issuer: "Acme", account: "ops" } },
      ],
    });
    const r = parseAuthenticatorJson(json);
    assert.equal(r.source, "2FAS");
    assert.equal(r.accounts.length, 2);
    assert.equal(r.accounts[0].account, "me");
  });

  test("Aegis, including the uri shortcut", () => {
    const json = JSON.stringify({
      version: 1,
      header: { slots: [{}] },
      db: {
        entries: [
          { type: "totp", name: "GitHub", issuer: "GitHub", info: { secret: filler(20), algo: "SHA1", digits: 6, period: 30 }, uri: `otpauth://totp/GitHub:me?secret=${filler(20)}&issuer=GitHub` },
          { type: "totp", name: "Acme", info: { secret: filler(20) } },
        ],
      },
    });
    const r = parseAuthenticatorJson(json);
    assert.equal(r.source, "Aegis");
    // The first entry is read from its uri, the second from its fields.
    assert.equal(r.accounts.length, 2);
    assert.equal(r.accounts[0].account, "me");
    assert.equal(r.accounts[1].issuer, "Acme");
  });

  test("Raivo array form", () => {
    const json = JSON.stringify([
      { issuer: "GitHub", account: "me", secret: filler(20), algorithm: "SHA1", digits: 6, timer: 30 },
    ]);
    const r = parseAuthenticatorJson(json);
    assert.equal(r.source, "Raivo");
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].period, 30);
  });

  test("Bitwarden, where the code lives under login.totp", () => {
    const json = JSON.stringify({
      items: [
        { name: "GitHub", login: { username: "me", totp: `otpauth://totp/GitHub:me?secret=${filler(20)}&issuer=GitHub` } },
        { name: "A login with no code", login: { username: "me" } },
      ],
    });
    const r = parseAuthenticatorJson(json);
    assert.equal(r.source, "Bitwarden");
    assert.equal(r.accounts.length, 1, "the plain login must not be counted");
  });

  test("Google Authenticator", () => {
    const json = JSON.stringify({
      otp_parameters: [{ secret: filler(20), name: "me", issuer: "GitHub", algorithm: "SHA1", digits: 6, type: "TOTP" }],
      version: 1,
    });
    const r = parseAuthenticatorJson(json);
    assert.equal(r.source, "Google Authenticator");
    assert.equal(r.accounts[0].issuer, "GitHub");
  });

  test("Microsoft Authenticator", () => {
    const json = JSON.stringify({
      AuthenticatorAccounts: [{ displayName: "GitHub", UserName: "me", SecretKey: filler(20) }],
    });
    const r = parseAuthenticatorJson(json);
    assert.equal(r.source, "Microsoft Authenticator");
    assert.equal(r.accounts.length, 1);
  });
});

describe("failure is a message, not a zero", () => {
  test("an unrecognised JSON file says so", () => {
    const r = parseAuthenticatorJson(JSON.stringify({ hello: "world" }));
    assert.equal(r.accounts.length, 0);
    assert.match(r.error, /Unrecognised/);
    // The message has to name what is supported, or the reader has no next step.
    assert.match(r.error, /Aegis/);
    assert.match(r.error, /Bitwarden/);
  });

  test("invalid JSON is reported as such", () => {
    assert.match(parseAuthenticatorJson("{broken").error, /Not valid JSON/);
  });

  test("a recognised dialect with no usable secrets lists why", () => {
    const r = parseAuthenticatorJson(JSON.stringify({ services: [{ name: "Bad", secret: "!!!" }] }));
    assert.equal(r.accounts.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /Bad/);
  });
});

describe("parseAuthenticatorExport", () => {
  test("a paste of URIs beats JSON detection", () => {
    const r = parseAuthenticatorExport(`otpauth://totp/Acme:me?secret=${filler(20)}&issuer=Acme`);
    assert.equal(r.source, "otpauth URIs");
    assert.equal(r.accounts.length, 1);
  });

  test("JSON falls through to the dialect parsers", () => {
    const r = parseAuthenticatorExport(JSON.stringify({ services: [{ name: "A", secret: filler(20) }] }));
    assert.equal(r.source, "2FAS");
  });
});

describe("describeImport and secretStrength", () => {
  test("summarises in a sentence a person can read", () => {
    assert.equal(describeImport({ accounts: [{}], skipped: [], source: "Aegis" }), "1 account, from Aegis");
    assert.equal(describeImport({ accounts: [{}, {}], skipped: [{}], source: "2FAS" }), "2 accounts, from 2FAS, 1 skipped");
    assert.match(describeImport({ error: "Not valid JSON" }), /Not valid JSON/);
  });

  test("reports the decoded byte length so a truncation is visible", () => {
    // 8 base32 characters is 5 bytes: a real TOTP secret is 10 to 64.
    assert.equal(secretStrength("JBSWY3DP"), 5);
    assert.ok(secretStrength(filler(20)) >= 20);
    assert.equal(secretStrength("!!!"), 0);
  });
});
