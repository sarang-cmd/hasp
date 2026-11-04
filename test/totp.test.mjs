import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hotp, totp, verify, parseOtpauth } from "../src/core/totp.js";
import { generateSet, looksLikeBackupCode, parseBlock, remaining } from "../src/core/backup-codes.js";

describe("base32", () => {
  test("decodes the RFC 4648 example strings", () => {
    assert.equal(base32Decode("MZXW6===").toString(), "foo");
    assert.equal(base32Decode("MZXW6YTB").toString(), "fooba");
    assert.equal(base32Decode("MZXW6YTBOI======").toString(), "foobar");
  });

  test("tolerates padding, spaces and lower case, as exports contain", () => {
    assert.equal(base32Decode("jbsw y3dp ehpk 3pxp").toString("hex"), base32Decode("JBSWY3DPEHPK3PXP").toString("hex"));
  });

  test("rejects characters outside the alphabet", () => {
    assert.throws(() => base32Decode("MZXW1==="), /invalid base32/);
    assert.throws(() => base32Decode(""), /empty/);
  });

  test("encodes back to the same bytes", () => {
    const buf = Buffer.from("foobar");
    assert.equal(base32Encode(buf), "MZXW6YTBOI");
    assert.equal(base32Decode(base32Encode(buf)).toString(), "foobar");
  });
});

describe("hotp", () => {
  // RFC 4226 appendix D.
  test("matches the RFC 4226 test vectors", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => {
      assert.equal(hotp(secret, counter), code, `counter ${counter}`);
    });
  });
});

describe("totp", () => {
  // RFC 6238 appendix B uses SHA1 with the same secret.
  test("matches the RFC 6238 SHA1 vectors", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const cases = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of cases) {
      assert.equal(totp(secret, { at: seconds * 1000, digits: 8 }).code, code, `at ${seconds}`);
    }
  });

  test("six digits is the default and the code changes each step", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const a = totp(secret, { at: 0 });
    const b = totp(secret, { at: 30_000 });
    assert.equal(a.code.length, 6);
    assert.notEqual(a.code, b.code);
  });

  test("remaining counts down inside the step", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    assert.equal(totp(secret, { at: 0 }).remaining, 30);
    assert.equal(totp(secret, { at: 15_000 }).remaining, 15);
    assert.equal(totp(secret, { at: 29_000 }).remaining, 1);
  });

  test("verifies the current code and one step of drift", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const at = 1_700_000_000_000;
    const code = totp(secret, { at }).code;
    assert.equal(verify(secret, code, { at }), true);
    assert.equal(verify(secret, code, { at: at + 30_000 }), true, "one step late is tolerated");
    assert.equal(verify(secret, code, { at: at + 90_000 }), false, "two steps late is not");
    assert.equal(verify(secret, "000000", { at }), false);
    assert.equal(verify(secret, `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`, { at }), false);
  });

  test("a submitted code with a space is still accepted", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const at = 1_700_000_000_000;
    const code = totp(secret, { at }).code;
    assert.equal(verify(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { at }), true);
  });
});

describe("otpauth", () => {
  test("parses a standard URI", () => {
    const parsed = parseOtpauth(
      "otpauth://totp/GitHub:sarang%40studio.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30"
    );
    assert.deepEqual(parsed, {
      issuer: "GitHub",
      account: "sarang@studio.dev",
      secret: "JBSWY3DPEHPK3PXP",
      digits: 6,
      step: 30,
      algorithm: "SHA1",
    });
  });

  test("accepts the label-only form with no issuer parameter", () => {
    const parsed = parseOtpauth("otpauth://totp/Acme:dev@acme.test?secret=JBSWY3DPEHPK3PXP");
    assert.equal(parsed.issuer, "Acme");
    assert.equal(parsed.account, "dev@acme.test");
  });

  test("rejects the wrong scheme, wrong type, and a missing or invalid secret", () => {
    assert.throws(() => parseOtpauth("https://totp/x?secret=JBSWY3DPEHPK3PXP"), /not an otpauth/);
    assert.throws(() => parseOtpauth("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP"), /unsupported otpauth type/);
    assert.throws(() => parseOtpauth("otpauth://totp/x"), /no secret/);
    assert.throws(() => parseOtpauth("otpauth://totp/x?secret=!!!!"), /invalid base32/);
  });
});

describe("backup codes", () => {
  test("generates the requested count with no duplicates", () => {
    const set = generateSet({ count: 10 });
    assert.equal(set.length, 10);
    assert.equal(new Set(set).size, 10);
    for (const code of set) assert.ok(looksLikeBackupCode(code), code);
  });

  test("codes avoid the letters that get misread", () => {
    const set = generateSet({ count: 40 });
    for (const code of set) assert.ok(!/[ILOU]/.test(code), `${code} contains an ambiguous letter`);
  });

  test("honours groups and prefix", () => {
    const [code] = generateSet({ count: 1, groups: 3, prefix: "GH" });
    assert.equal(code.match(/-/g).length, 3);
    assert.ok(code.startsWith("GH-"));
  });

  test("rejects nonsense counts", () => {
    assert.throws(() => generateSet({ count: 0 }));
    assert.throws(() => generateSet({ count: 101 }));
    assert.throws(() => generateSet({ groups: 9 }));
  });

  test("parses a pasted block with list numbering and stray blank lines", () => {
    const block = `
      1. ABCD-EFGH
      2) IJKM-NPQR

      3. STVW-XY23
      some prose that is not a code
      4. 4567-89AB
    `;
    assert.deepEqual(parseBlock(block), ["ABCD-EFGH", "IJKM-NPQR", "STVW-XY23", "4567-89AB"]);
  });

  test("counts unused codes", () => {
    const codes = [{ code: "A" }, { code: "B", usedAt: "2026-01-01" }, { code: "C" }];
    assert.equal(remaining(codes), 2);
  });
});
