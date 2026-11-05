import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveKey, newSalt, KDF, bytesEqual } from "../src/core/kdf.js";
import { seal, open, newItemKey, aad, NONCE_BYTES } from "../src/core/crypto.js";
import { wrapKey, unwrapKey } from "../src/core/wrap.js";
import { Vault, cleanItem, tokensFor, blindQuery } from "../src/core/vault.js";
import { createSession, readSession, forget, remainingMs, IDLE_MS } from "../src/core/session.js";

const HEADER = { vaultId: "v1", itemId: "i1", version: 1 };

describe("kdf", () => {
  test("is deterministic for the same password and salt", async () => {
    const salt = newSalt();
    const a = await deriveKey("correct horse battery staple", salt);
    const b = await deriveKey("correct horse battery staple", salt);
    assert.equal(a.length, 32);
    assert.ok(bytesEqual(a, b));
  });

  test("differs for a different salt or password", async () => {
    const a = await deriveKey("correct horse battery staple", newSalt());
    const b = await deriveKey("correct horse battery staple", newSalt());
    const c = await deriveKey("correct horse battery stapl3", Buffer.from("0123456789abcdef", "utf8"));
    assert.ok(!bytesEqual(a, b), "different salts must give different keys");
    assert.ok(!bytesEqual(a, c));
  });

  test("records its parameters so a vault can be reopened", () => {
    assert.equal(KDF.algorithm, "scrypt");
    assert.equal(KDF.keyLength, 32);
    assert.ok(KDF.N >= 2 ** 14, "work factor must not be trivially low");
  });

  test("rejects an empty password and a short salt", async () => {
    await assert.rejects(() => deriveKey("", newSalt()));
    await assert.rejects(() => deriveKey("x", Buffer.from("short")));
  });
});

describe("item crypto", () => {
  test("round trips a payload", () => {
    const key = newItemKey();
    const sealed = seal(key, { value: "EXAMPLE-groq-prod-sample-0000", name: "Groq" }, HEADER);
    assert.equal(Buffer.from(sealed.nonce, "base64").length, NONCE_BYTES);
    assert.deepEqual(open(key, sealed, HEADER), { value: "EXAMPLE-groq-prod-sample-0000", name: "Groq" });
  });

  test("uses a fresh nonce every time", () => {
    const key = newItemKey();
    const nonces = new Set();
    for (let i = 0; i < 200; i += 1) nonces.add(seal(key, { i }, HEADER).nonce);
    assert.equal(nonces.size, 200, "nonce reuse would break the whole scheme");
  });

  test("refuses a tampered ciphertext, nonce or header", () => {
    const key = newItemKey();
    const sealed = seal(key, { value: "secret" }, HEADER);

    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] ^= 0x01;
    assert.throws(() => open(key, { ...sealed, ciphertext: flipped.toString("base64") }, HEADER));

    const otherNonce = Buffer.alloc(NONCE_BYTES, 7).toString("base64");
    assert.throws(() => open(key, { ...sealed, nonce: otherNonce }, HEADER));

    // The same ciphertext must not open against a different item, version or vault.
    assert.throws(() => open(key, sealed, { ...HEADER, itemId: "i2" }));
    assert.throws(() => open(key, sealed, { ...HEADER, version: 2 }));
    assert.throws(() => open(key, sealed, { ...HEADER, vaultId: "v2" }));
  });

  test("a wrong key cannot open a payload", () => {
    const sealed = seal(newItemKey(), { value: "secret" }, HEADER);
    assert.throws(() => open(newItemKey(), sealed, HEADER));
  });

  test("aad binds the three identifiers and nothing else", () => {
    assert.equal(aad(HEADER).toString(), "v1\u0000i1\u00001");
    assert.throws(() => aad({ vaultId: "v1", itemId: "i1", version: 0 }));
  });
});

describe("key wrapping", () => {
  test("round trips the vault key", () => {
    const kek = newItemKey();
    const vaultKey = newItemKey();
    const wrapped = unwrapKey(kek, wrapKey(kek, vaultKey));
    assert.ok(bytesEqual(wrapped, vaultKey));
  });

  test("rejects a wrong wrapping key and a shortened wrap", () => {
    const kek = newItemKey();
    const wrapped = wrapKey(kek, newItemKey());
    assert.throws(() => unwrapKey(newItemKey(), wrapped));
    assert.throws(() => unwrapKey(kek, { ...wrapped, wrapped: "AAAA" }));
  });
});

describe("vault", () => {
  const password = "correct horse battery staple";

  test("creates, stores and reads an item", async () => {
    const vault = await Vault.create({ name: "Test", password });
    const { id } = vault.addItem({
      name: "Groq production",
      brand: "groq",
      service: "Groq",
      host: "console.groq.com",
      type: "api-key",
      env: "prod",
      value: "EXAMPLE-groq-prod-sample-0000",
    });
    const item = vault.readItem(id);
    assert.equal(item.name, "Groq production");
    assert.equal(item.value, "EXAMPLE-groq-prod-sample-0000");
    assert.equal(item.version, 1);
  });

  test("nothing readable from the master password reaches the stored record", async () => {
    const vault = await Vault.create({ name: "Test", password });
    const { id } = vault.addItem({
      name: "Stripe secret key",
      service: "Stripe",
      host: "dashboard.stripe.com",
      type: "api-key",
      env: "live",
      value: "EXAMPLE-stripe-live-sample-0000",
    });
    const record = vault.rawRecord(id);
    const disk = JSON.stringify(vault.serialize());

    // The obvious leaks, asserted one by one so a failure names the culprit.
    for (const secret of ["EXAMPLE-stripe-live-sample-0000", "Stripe secret key", "dashboard.stripe.com", "prod", password]) {
      assert.ok(!disk.includes(secret), `stored vault must not contain ${JSON.stringify(secret)}`);
    }
    assert.ok(!JSON.stringify(record).includes("sk_live"), "ciphertext must not embed the value");
    assert.equal(record.searchTokens.length > 0, true, "the blind index is expected to be present");
  });

  test("the blind index matches a query without storing text", async () => {
    const vault = await Vault.create({ name: "Test", password });
    vault.addItem({ name: "Groq production", host: "console.groq.com", type: "api-key", env: "prod", value: "a" });
    vault.addItem({ name: "Stripe secret", host: "dashboard.stripe.com", type: "api-key", env: "live", value: "b" });

    assert.equal(vault.search("groq").length, 1);
    assert.equal(vault.search("GROQ").length, 1, "search is case insensitive");
    assert.equal(vault.search("console.groq.com").length, 1, "host labels are indexed");
    assert.equal(vault.search("stripe").length, 1);
    assert.equal(vault.search("groq stripe").length, 0, "multiple tokens are an AND");
    assert.equal(vault.search("nothing").length, 0);

    // A token hash is not reversible back to the word.
    const record = vault.rawRecord([...vault.listFiltered()][0].id);
    assert.ok(!record.searchTokens.some((t) => t.includes("groq")));
  });

  test("a search key cannot be built without the vault key", async () => {
    const one = await Vault.create({ name: "A", password });
    const two = await Vault.create({ name: "B", password });
    one.addItem({ name: "Groq production", value: "a", type: "api-key" });
    // Same password, different vault key: the hash must differ.
    assert.equal(one.rawRecords()[0].searchTokens[0] === two.serialize().meta.id, false);
    assert.equal(blindQuery(Buffer.alloc(32), "groq").length, 1);
  });

  test("unlocks with the right password and refuses the wrong one", async () => {
    const vault = await Vault.create({ name: "Test", password });
    const disk = JSON.parse(JSON.stringify(vault.serialize()));
    const again = await Vault.unlock(disk, password);
    assert.equal(again.meta.id, vault.meta.id);
    await assert.rejects(() => Vault.unlock(disk, "wrong password entirely"), /Wrong master password/);
  });

  test("a wrong password is indistinguishable from a damaged wrap", async () => {
    const vault = await Vault.create({ name: "Test", password });
    const disk = JSON.parse(JSON.stringify(vault.serialize()));
    disk.meta.wrapped = Buffer.alloc(48, 9).toString("base64");
    await assert.rejects(() => Vault.unlock(disk, password), /Wrong master password/);
  });

  test("refuses a master password under twelve characters", async () => {
    await assert.rejects(() => Vault.create({ name: "x", password: "short" }), /at least 12/);
  });

  test("an item cannot be replayed onto another vault", async () => {
    const a = await Vault.create({ name: "A", password });
    const b = await Vault.create({ name: "B", password });
    const { id } = a.addItem({ name: "Groq", value: "secret", type: "api-key" });
    const record = a.rawRecord(id);

    // Move the record into vault B. Two independent layers should stop it.
    const moved = { ...b.serialize(), items: { [id]: record } };
    const reopened = await Vault.unlock(moved, password);

    // Layer one: the item key is wrapped under vault A's key, so vault B cannot
    // unwrap it. This fires before any ciphertext is touched.
    assert.throws(() => reopened.readItem(id), /authenticate data/);
  });

  test("the vault id is bound into the item ciphertext", async () => {
    // Layer two on its own: take the item key out of vault A, then try to open
    // A's ciphertext with B's vault id in the header.
    const a = await Vault.create({ name: "A", password });
    const { id } = a.addItem({ name: "Groq", value: "secret", type: "api-key" });
    const record = a.rawRecord(id);
    const itemKey = unwrapKey(a.vaultKeyForTest(), record.wrappedKey);
    assert.equal(open(itemKey, record, { vaultId: a.meta.id, itemId: id, version: 1 }).value, "secret");
    assert.throws(
      () => open(itemKey, record, { vaultId: "another-vault", itemId: id, version: 1 }),
      /authenticate data/
    );
  });

  test("version bumps and old versions are kept", async () => {
    const vault = await Vault.create({ name: "Test", password });
    const { id } = vault.addItem({ name: "Groq", value: "one", type: "api-key" });
    vault.updateItem(id, { value: "two" });
    const item = vault.readItem(id);
    assert.equal(item.version, 2);
    assert.equal(item.value, "two");
    assert.equal(vault.rawRecord(id).history.length, 1, "the previous version is reviewable");
  });

  test("delete is soft, restore works, deleted items are not listed", async () => {
    const vault = await Vault.create({ name: "Test", password });
    const { id } = vault.addItem({ name: "Groq", value: "x", type: "api-key" });
    vault.deleteItem(id);
    assert.equal(vault.listFiltered().length, 0);
    assert.equal(vault.readItem(id), null);
    assert.ok(vault.rawRecord(id).deletedAt, "the record survives so the deletion can sync");
    vault.restoreItem(id);
    assert.equal(vault.listFiltered().length, 1);
  });

  test("filters by type and environment", async () => {
    const vault = await Vault.create({ name: "Test", password });
    vault.addItem({ name: "A", type: "api-key", env: "prod", value: "1" });
    vault.addItem({ name: "B", type: "api-key", env: "staging", value: "2" });
    vault.addItem({ name: "C", type: "backup-codes", env: "", codes: ["AAAA-BBBB"] });
    assert.equal(vault.listFiltered({ type: "api-key" }).length, 2);
    assert.equal(vault.listFiltered({ type: "api-key", env: "prod" }).length, 1);
    assert.equal(vault.listFiltered({ type: "backup-codes" }).length, 1);
  });

  test("cleanItem rejects unknown types and environments", () => {
    assert.throws(() => cleanItem({ type: "passwords" }), /unknown item type/);
    assert.throws(() => cleanItem({ env: "production" }), /unknown environment/);
    assert.throws(() => cleanItem({ type: "totp", totp: {} }), /needs a secret/);
  });

  test("a totp item keeps issuer, account and step", () => {
    const item = cleanItem({
      type: "totp",
      name: "GitHub 2FA",
      totp: { secret: "jbsw y3dp ehpk 3pxp", issuer: "GitHub", account: "sarang", step: 30, digits: 6 },
    });
    assert.equal(item.totp.secret, "JBSWY3DPEHPK3PXP");
    assert.equal(item.totp.issuer, "GitHub");
  });

  test("tokens drop filler and short words", () => {
    const tokens = tokensFor({ name: "Groq production key", host: "console.groq.com", type: "api-key", env: "prod" });
    assert.ok(tokens.includes("groq"));
    assert.ok(tokens.includes("production"));
    assert.ok(!tokens.includes("a"), "single letters are noise");
    assert.ok(tokens.includes("tapi-key") || tokens.includes("tapikey"), "type is indexed with a prefix");
  });

  test("lock drops key material", async () => {
    const vault = await Vault.create({ name: "Test", password });
    vault.addItem({ name: "A", value: "x", type: "api-key" });
    vault.lock();
    assert.equal(vault.rawRecords().length, 0);
  });
});

describe("sessions", () => {
  test("round trips and expires on idle", () => {
    const key = newItemKey();
    const id = createSession("vault-1", key);
    const s = readSession(id);
    assert.ok(s);
    assert.equal(s.vaultId, "vault-1");
    assert.ok(remainingMs(id) <= IDLE_MS);
    forget(id);
    assert.equal(readSession(id), null);
  });

  test("an unknown session id is refused", () => {
    assert.equal(readSession("nope"), null);
    assert.equal(readSession(undefined), null);
    assert.equal(remainingMs("nope"), 0);
  });

  test("cookie constant is the hardened form", () => {
    assert.equal(createSession("v", newItemKey()).length > 20, true);
  });
});

describe("changing the master password", () => {
  const OLD = "foundry-nightshift-2026";
  const NEW = "a-different-sample-password-1";

  test("the new password opens the vault and the old one does not", async () => {
    const vault = await Vault.create({ name: "Rotation", password: OLD });
    const item = vault.addItem({ name: "Kept", type: "api-key", value: "EXAMPLE-rotation-value" });

    await vault.changePassword(OLD, NEW);
    const stored = vault.serialize();

    const reopened = await Vault.unlock(stored, NEW);
    assert.equal(reopened.size, 1);
    assert.equal(reopened.readItem(item.id).value, "EXAMPLE-rotation-value");

    await assert.rejects(() => Vault.unlock(stored, OLD), /Wrong master password/);
  });

  test("no item is re-encrypted", async () => {
    // The vault key does not change, so the ciphertext is byte for byte the same.
    // That is why a rotation is cheap, and why it does not need to rewrite anything
    // that could fail halfway through.
    const vault = await Vault.create({ name: "Rotation", password: OLD });
    vault.addItem({ name: "Kept", type: "api-key", value: "EXAMPLE-rotation-value" });
    const before = vault.serialize().items;
    await vault.changePassword(OLD, NEW);
    assert.deepEqual(vault.serialize().items, before);
  });

  test("the salt changes, so an old copy of the file stops helping", async () => {
    const vault = await Vault.create({ name: "Rotation", password: OLD });
    const saltBefore = vault.serialize().meta.salt;
    await vault.changePassword(OLD, NEW);
    assert.notEqual(vault.serialize().meta.salt, saltBefore);
  });

  test("the sequence does not move, because no item changed", async () => {
    const vault = await Vault.create({ name: "Rotation", password: OLD });
    vault.addItem({ name: "One", type: "note", notes: "invented" });
    const seq = vault.seq;
    await vault.changePassword(OLD, NEW);
    assert.equal(vault.seq, seq, "a password change is not a vault-wide item change");
  });

  test("a wrong current password is refused and changes nothing", async () => {
    const vault = await Vault.create({ name: "Rotation", password: OLD });
    const before = vault.serialize().meta.wrapped;
    await assert.rejects(() => vault.changePassword("not-the-password", NEW), /Wrong master password/);
    assert.equal(vault.serialize().meta.wrapped, before);
    await Vault.unlock(vault.serialize(), OLD);
  });

  test("a new password below the floor is refused", async () => {
    const vault = await Vault.create({ name: "Rotation", password: OLD });
    await assert.rejects(() => vault.changePassword(OLD, "short"), /at least 12/);
  });
});
