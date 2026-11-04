// The second machine, tested as a program rather than as a library.
//
// The interesting cases are the refusals: a missing flag, a refused token, a vault
// id the other side has never seen, a wrong password, and a record that cannot be
// opened. Each has to fail with a sentence and a non-zero exit, because the caller
// is a person at a terminal deciding whether their data arrived.
//
// Every secret here is invented.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault } from "../src/core/vault.js";
import { SAMPLE_PASSWORD } from "../src/core/seed.js";
import { parseArgs, missing, baseUrl, main, apply } from "../tools/sync.mjs";

/** A vault on disk, as a string, plus its password. */
async function vaultOnDisk() {
  const dir = await mkdtemp(join(tmpdir(), "hasp-sync-"));
  const path = join(dir, "vault.json");
  const vault = await Vault.create({ name: "Remote", password: SAMPLE_PASSWORD });
  vault.addItem({ name: "Pulled item", type: "api-key", service: "Delta", value: "EXAMPLE-delta" });
  await writeFile(path, JSON.stringify(vault.serialize(), null, 2));
  return { path, dir, vault };
}

/** Collect log lines so a test can read what the user would see. */
function logger() {
  const lines = [];
  return { log: (line) => lines.push(line), lines };
}

/** A fetch that answers with a fixed body, and records what it was asked. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

/** The flags a working invocation needs, as argv, which is what `main` takes. */
const GOOD = {
  "--vault": "/tmp/vault.json",
  "--url": "http://192.168.1.20:3000",
  "--vault-id": "v-1",
  "--token": "t-1",
};

/** The same flags as a flat argv array. */
const ARGV = Object.entries(GOOD).flat();

/** `missing` reads parsed args, so every call parses first. */
const gapsFor = (flags) => missing(parseArgs(flags));

describe("sync tool arguments", () => {
  test("long flags pair with their values and bare flags stand alone", () => {
    const args = parseArgs(["--vault", "/v.json", "--help", "--token", "abc"]);
    assert.equal(args.vault, "/v.json");
    assert.equal(args.token, "abc");
    assert.equal(args.help, true);
  });

  test("a flag with no value is not mistaken for the next flag's value", () => {
    const args = parseArgs(["--vault", "--token", "abc"]);
    assert.equal(args.vault, true, "a bare flag stays a flag");
    assert.equal(args.token, "abc");
  });

  test("each missing flag is named with what it is for", () => {
    const gaps = gapsFor([]);
    assert.equal(gaps.length, 4);
    assert.ok(gaps.some((g) => g.includes("--vault")));
    assert.ok(gaps.some((g) => g.includes("--vault-id")));
    // A bare flag counts as missing, not as supplied.
    const bare = gapsFor(ARGV.filter((a) => a !== "/tmp/vault.json"));
    assert.equal(bare.length, 1);
    assert.match(bare[0], /--vault/);
    // And a flag with nothing after it does not borrow the next flag as its value,
    // which is why the count is two here: both ends of the pair are unterminated.
    const dangling = gapsFor(["--vault", "--url", "http://x:3000", "--vault-id", "v", "--token"]);
    assert.equal(dangling.length, 2);
    // And a complete set reports nothing.
    assert.deepEqual(gapsFor(ARGV), []);
  });

  test("the url is reduced to an origin so a path cannot be doubled", () => {
    assert.equal(baseUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
    assert.equal(baseUrl("https://host.example/hasp/"), "https://host.example/hasp");
    assert.throws(() => baseUrl("file:///etc/passwd"), /http/);
    assert.throws(() => baseUrl("not a url"));
  });
});

describe("sync tool run", () => {
  test("a missing flag exits 2 and says nothing was attempted", async () => {
    const { log, lines } = logger();
    const code = await main(["--url", "http://x.example"], { log });
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.startsWith("Missing:")));
  });

  test("no password in the environment exits 2 and explains why it is not a flag", async () => {
    const { log, lines } = logger();
    const code = await main(ARGV, { log, password: "" });
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes("HASP_PASSWORD")));
    assert.ok(lines.some((l) => l.includes("shell history")));
  });

  test("a vault file that is not there exits 2 without touching the network", async () => {
    const { log } = logger();
    const fetch = stubFetch({});
    const code = await main(Object.entries({ ...GOOD, "--vault": "/tmp/definitely-not-here/vault.json" }).flat(), {
      log,
      password: SAMPLE_PASSWORD,
      fetch,
    });
    assert.equal(code, 2);
    assert.equal(fetch.calls.length, 0, "it did not call the other machine");
  });

  test("a refused token exits 1 and says what to do about it", async () => {
    const { path } = await vaultOnDisk();
    const { log, lines } = logger();
    const code = await main(Object.entries({ ...GOOD, "--vault": path }).flat(), {
      log,
      password: SAMPLE_PASSWORD,
      fetch: stubFetch({ error: "bad token" }, { status: 401 }),
    });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => /rotated/.test(l)), lines.join("\n"));
  });

  test("an unknown vault id exits 1 and blames the id, not the token", async () => {
    const { path } = await vaultOnDisk();
    const { log, lines } = logger();
    const code = await main(Object.entries({ ...GOOD, "--vault": path }).flat(), {
      log,
      password: SAMPLE_PASSWORD,
      fetch: stubFetch({ error: "no such vault" }, { status: 404 }),
    });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("does not know that vault id")));
  });

  test("the request carries the vault id, the token and where to resume from", async () => {
    const { path, vault } = await vaultOnDisk();
    const { log } = logger();
    const fetch = stubFetch({ records: [], seq: vault.seq });
    await main(Object.entries({ ...GOOD, "--vault": path }).flat(), {
      log,
      password: SAMPLE_PASSWORD,
      fetch,
    });
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].body.vaultId, "v-1");
    assert.equal(fetch.calls[0].body.token, "t-1");
    assert.equal(fetch.calls[0].body.since, vault.seq, "it resumes from the vault's own sequence");
  });

  test("a wrong password exits 1 and does not write the file", async () => {
    const { path, vault } = await vaultOnDisk();
    const before = await readFile(path, "utf8");
    const { log, lines } = logger();
    const code = await main(Object.entries({ ...GOOD, "--vault": path }).flat(), {
      log,
      password: "definitely-not-the-password",
      fetch: stubFetch({ records: [vault.rawRecords()[0]], seq: 1 }),
    });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("does not open that vault")));
    assert.equal(await readFile(path, "utf8"), before, "the file is untouched");
  });

  test("a genuine record lands and is written to the file", async () => {
    // The pulling machine already holds the vault key, which is what a second
    // machine has after the file has been copied across once. It does not yet hold
    // the record made after that copy, and that is what a pull delivers.
    const target = await vaultOnDisk();
    // The source is the same vault, moved on by one record and one revision.
    const source = await Vault.unlock(target.vault.serialize(), SAMPLE_PASSWORD);
    const { id } = source.addItem({ name: "Made later", type: "api-key", value: "EXAMPLE-later" });

    const before = JSON.parse(await readFile(target.path, "utf8"));
    assert.equal(before.items[id], undefined, "the target does not have it yet");

    const { log, lines } = logger();
    const code = await main(Object.entries({ ...GOOD, "--vault": target.path }).flat(), {
      log,
      password: SAMPLE_PASSWORD,
      fetch: stubFetch({ records: [source.rawRecord(id)], seq: source.seq }),
    });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => /applied/.test(l)), lines.join("\n"));
    const after = JSON.parse(await readFile(target.path, "utf8"));
    assert.ok(after.items[id], "the record was written");
  });

  test("a record that cannot be opened is counted, kept out, and exits 1", async () => {
    const stranger = await Vault.create({ name: "Stranger", password: SAMPLE_PASSWORD });
    stranger.addItem({ name: "Not yours", type: "api-key", value: "EXAMPLE-nope" });
    const target = await vaultOnDisk();
    const before = JSON.parse(await readFile(target.path, "utf8"));

    const { log, lines } = logger();
    const code = await main(Object.entries({ ...GOOD, "--vault": target.path }).flat(), {
      log,
      password: SAMPLE_PASSWORD,
      fetch: stubFetch({ records: stranger.rawRecords(), seq: 99 }),
    });
    assert.equal(code, 1, "a refusal exits non-zero even when nothing else went wrong");
    assert.ok(lines.some((l) => /could not be opened/.test(l)));
    const after = JSON.parse(await readFile(target.path, "utf8"));
    assert.deepEqual(Object.keys(after.items).sort(), Object.keys(before.items).sort(), "nothing was added");
  });

  test("help exits 0 and names the password variable", async () => {
    const { log, lines } = logger();
    const code = await main(["--help"], { log });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes("HASP_PASSWORD")));
  });
});

describe("apply", () => {
  test("an unchanged pull does not rewrite the file", async () => {
    const { path, vault } = await vaultOnDisk();
    const out = join(await mkdtemp(join(tmpdir(), "hasp-sync-")), "copy.json");
    await writeFile(out, JSON.stringify(vault.serialize(), null, 2));
    const first = await readFile(out, "utf8");
    const result = await apply({
      stored: vault.serialize(),
      password: SAMPLE_PASSWORD,
      records: vault.rawRecords(),
      out,
      Vault,
    });
    assert.equal(result.applied, 0);
    assert.equal(result.written, false);
    assert.equal(await readFile(out, "utf8"), first, "an idle run does not touch the file");
    void path;
  });
});
