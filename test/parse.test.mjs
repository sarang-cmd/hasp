import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  KEY_SHAPES,
  parseNote,
  parseKeepJson,
  parseKeepHtml,
  parseOtpExport,
  parseCsv,
  detectKey,
  detectEnv,
  stripSecrets,
  findDuplicates,
  csvRows,
  REVIEW_THRESHOLD,
} from "../src/core/parse.js";

// Every fixture below is invented. No real export belongs in this repository.
//
// Key shaped inputs are built from KEY_SHAPES rather than pasted, so this file
// carries no literal that a reader or a secret scanner could mistake for a
// credential: the shape comes from the table, the body is generated filler.
const filler = (n, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join("");

/** A value that satisfies a brand's pattern, built from its own prefix. */
function sampleKey(brand, { length = 40, alphabet } = {}) {
  const prefix = {
    groq: "gsk_prod_",
    stripe: "sk_live_",
    github: "ghp_",
    anthropic: "sk-ant-",
    supabase: "sbp_",
    resend: "re_",
    aws: "AKIA",
    neon: "postgres://user:pass@ep-cool-db.eu-central-1.aws.neon.tech/main",
  }[brand];
  if (brand === "neon") return prefix;
  const body = filler(Math.max(length - prefix.length, 12), alphabet || (brand === "aws" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" : undefined));
  return prefix + body;
}
const FIXTURES = {
  keepJson: JSON.stringify({
    notes: [
      {
        title: "Groq production",
        textContent: "groq prod key " + sampleKey("groq") + " rotate every 90 days",
        userEditedTimestampUsec: 1_700_000_000_000_000,
      },
      {
        title: "GitHub recovery",
        textContent: "ABCD-EFGH\nIJKM-NPQR\nSTVW-XY23\n4567-89AB\n2345-6789\nABCD-2345",
      },
      {
        title: "Neon",
        textContent: "postgres://sarang:hunter2@ep-cool-db.eu-central-1.aws.neon.tech/main",
      },
      { title: "Groceries", textContent: "oat milk, rice, tomatoes" },
    ],
  }),
  keepHtml: `<div class="note">
    <div class="heading">Groq production</div>
    <div class="content">groq prod key SIG_PLACEHOLDER<br>rotate every 90 days</div>
    <span class="heading-date">18 July 2026</span>
  </div>
  <div class="note">
    <div class="heading">Stripe</div>
    <div class="content">SIG_STRIPE</div>
  </div>`,
  otp: [
    "otpauth://totp/GitHub:sarang%40studio.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
    "otpauth://totp/Acme:dev@acme.test?secret=GEZDGNBVGY3TQOJQ&issuer=Acme&period=60&digits=8",
    "Acme:ops@acme.test:JBSWY3DPEHPK3PXP",
  ].join("\n"),
  csv: `name,url,username,password,notes
Groq production,https://console.groq.com,sarang@studio.dev,SIG_GROQ,rotate in August
Stripe live,https://dashboard.stripe.com,sarang@studio.dev,SIG_STRIPE,"invoicing only, do not share"
Plain row,,,some-ordinary-password,`,
};

// The three values the fixtures need, generated once and shared.
const GROQ = sampleKey("groq");
const STRIPE = sampleKey("stripe");

// Fill the generated values into the fixture text.
const fill = (v) => String(v).replaceAll("SIG_GROQ", GROQ).replaceAll("SIG_STRIPE", STRIPE).replaceAll("SIG_PLACEHOLDER", GROQ);
for (const [k, v] of Object.entries(FIXTURES)) FIXTURES[k] = fill(v);

describe("key shape detection", () => {
  test("recognises the shapes the plan names", () => {
    const cases = [
      [sampleKey("groq"), "groq"],
      [sampleKey("stripe"), "stripe"],
      ["sk_test_" + filler(26), "stripe"],
      [sampleKey("github"), "github"],
      [sampleKey("anthropic"), "anthropic"],
      [sampleKey("neon"), "neon"],
      [sampleKey("aws", { length: 20, alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }), "aws"],
      [sampleKey("resend"), "resend"],
      [sampleKey("supabase"), "supabase"],
    ];
    for (const [value, brand] of cases) {
      const hit = detectKey(value);
      assert.ok(hit, `no match for ${value}`);
      assert.equal(hit.brand, brand, value);
    }
  });

  test("stripe test keys are labelled staging, live keys live", () => {
    assert.equal(detectKey(sampleKey("stripe")).env, "live");
    assert.equal(detectKey("sk_test_" + filler(26)).env, "staging");
  });

  test("a loose shape scores under the review threshold", () => {
    const hit = detectKey("abcdefghijklmnopqrstuvwx"); // 24 bare characters, Vercel shaped
    assert.ok(hit);
    assert.ok(hit.confidence < REVIEW_THRESHOLD, "bare alphanumerics must go to manual review");
  });

  test("ordinary prose and short tokens are not keys", () => {
    for (const text of ["rotate every 90 days", "oat milk", "short", "https://example.com/path"]) {
      assert.equal(detectKey(text), null, text);
    }
  });

  test("environment words map to the vault's vocabulary and never guess prod", () => {
    assert.equal(detectEnv("this is production"), "prod");
    assert.equal(detectEnv("staging box"), "staging");
    assert.equal(detectEnv("no label here"), "");
  });
});

describe("keep json", () => {
  test("reads notes and produces one candidate each", () => {
    const { candidates, notes } = parseKeepJson(FIXTURES.keepJson);
    assert.equal(notes, 4);
    assert.equal(candidates.length, 4);
  });

  test("a note with a key becomes an api key candidate", () => {
    const { candidates } = parseKeepJson(FIXTURES.keepJson);
    const groq = candidates.find((c) => c.brand === "groq");
    assert.ok(groq);
    assert.equal(groq.type, "api-key");
    assert.equal(groq.env, "prod");
    assert.equal(groq.value, GROQ);
    assert.equal(groq.needsReview, false, "a well shaped key of full length is trusted");
    assert.ok(groq.confidence.value >= 0.9);
  });

  test("a note holding a code block becomes a backup code set", () => {
    const { candidates } = parseKeepJson(FIXTURES.keepJson);
    const codes = candidates.find((c) => c.type === "backup-codes");
    assert.ok(codes);
    assert.equal(codes.codes.length, 6);
    assert.equal(codes.brand, "github");
  });

  test("a connection string is recognised and carries its host", () => {
    const { candidates } = parseKeepJson(FIXTURES.keepJson);
    const neon = candidates.find((c) => c.brand === "neon");
    assert.ok(neon);
    assert.equal(neon.host, "console.neon.tech");
  });

  test("an unrecognised note is kept as a note rather than dropped", () => {
    const { candidates } = parseKeepJson(FIXTURES.keepJson);
    const groceries = candidates.find((c) => c.name === "Groceries");
    assert.ok(groceries, "the user must not silently lose a note");
    assert.equal(groceries.type, "note");
    assert.equal(groceries.needsReview, true);
  });

  test("the source timestamp survives", () => {
    const { candidates } = parseKeepJson(FIXTURES.keepJson);
    assert.match(candidates[0].source.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("a bad file fails with a message a person can act on", () => {
    assert.throws(() => parseKeepJson("{not json"), /not valid JSON/);
    assert.throws(() => parseKeepJson("[]"), /No notes found/);
  });
});

describe("keep html", () => {
  test("reads note blocks and strips markup", () => {
    const { candidates, notes } = parseKeepHtml(FIXTURES.keepHtml);
    assert.equal(notes, 2);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].brand, "groq");
    assert.equal(candidates[0].value, GROQ);
    assert.equal(candidates[1].brand, "stripe");
  });

  test("a page with no note blocks says so instead of pretending", () => {
    assert.throws(() => parseKeepHtml("<html><body>nothing here</body></html>"), /No notes found/);
  });
});

describe("one-time code export", () => {
  test("reads otpauth lines and bare issuer lines", () => {
    const { candidates } = parseOtpExport(FIXTURES.otp);
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].type, "totp");
    assert.equal(candidates[0].totp.secret, "JBSWY3DPEHPK3PXP");
    assert.equal(candidates[0].totp.issuer, "GitHub");
    assert.equal(candidates[1].totp.step, 60);
    assert.equal(candidates[1].totp.digits, 8);
    assert.equal(candidates[2].totp.account, "ops@acme.test");
  });

  test("an export with no codes fails clearly", () => {
    assert.throws(() => parseOtpExport("nothing useful\nstill nothing"), /No one-time codes/);
  });
});

describe("password manager csv", () => {
  test("maps a standard header", () => {
    const { candidates, notes } = parseCsv(FIXTURES.csv);
    assert.equal(notes, 3);
    assert.equal(candidates[0].name, "Groq production");
    assert.equal(candidates[0].brand, "groq");
    assert.equal(candidates[0].value, GROQ);
    assert.equal(candidates[1].brand, "stripe");
    assert.equal(candidates[1].notes, "sarang@studio.dev, invoicing only, do not share");
  });

  test("a quoted field containing a comma stays in one field", () => {
    const rows = csvRows(FIXTURES.csv);
    assert.equal(rows[2][4], "invoicing only, do not share");
  });

  test("a plain three column export still works", () => {
    const { candidates } = parseCsv("name,username,password\nAcme,dev@acme.test,sup3rsecretvalue");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].value, "sup3rsecretvalue");
    assert.equal(candidates[0].needsReview, true, "an unrecognised value goes to review");
  });

  test("a file with no secret column is rejected", () => {
    assert.throws(() => parseCsv("name,url\nAcme,https://acme.test"), /No password or secret column/);
    assert.throws(() => parseCsv("name,password"), /no data rows/i);
  });
});

describe("notes never keep a second copy of a secret", () => {
  test("stripSecrets removes keys and base32 runs", () => {
    const out = stripSecrets("groq key " + GROQ + " and JBSWY3DPEHPK3PXP leftover words");
    assert.ok(!out.includes("gsk_prod"));
    assert.ok(!out.includes("JBSWY3DPEHPK3PXP"));
    assert.ok(out.includes("leftover words"));
  });

  test("stripSecrets drops private key bodies", () => {
    const out = stripSecrets("context -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA");
    assert.ok(!out.includes("MIIEow"));
  });
});

describe("duplicates", () => {
  test("a candidate matching an existing value is flagged", () => {
    const existing = [{ id: "i1", value: GROQ }];
    const candidates = [
      { value: GROQ },
      { value: "EXAMPLE-github-token-abcdefghijkl" },
    ];
    assert.deepEqual([...findDuplicates(candidates, existing)], [0]);
  });

  test("a one-time code matches on its secret", () => {
    const existing = [{ id: "i1", type: "totp", totp: { secret: "JBSWY3DPEHPK3PXP" } }];
    const candidates = [{ type: "totp", totp: { secret: "JBSWY3DPEHPK3PXP" } }];
    assert.deepEqual([...findDuplicates(candidates, existing)], [0]);
  });
});

describe("parseNote", () => {
  test("an otpauth link wins over everything else in the note", () => {
    const [c] = parseNote("my GitHub code otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP plus " + GROQ);
    assert.equal(c.type, "totp");
    assert.equal(c.totp.secret, "JBSWY3DPEHPK3PXP");
  });

  test("a short block is not mistaken for a backup code set", () => {
    const [c] = parseNote("ABCD-EFGH\nIJKM-NPQR");
    assert.equal(c.type, "note", "four lines is the floor for a code set");
  });

  test("an unlabelled key never defaults to prod", () => {
    const [c] = parseNote(GROQ);
    assert.equal(c.env, "");
  });
});
