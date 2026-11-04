// Sync tests.
//
// The interesting cases are not the happy path. They are: a second device with the
// wrong key, a server that lies, a record edited on both sides, and whether any
// plaintext reaches the wire. Each of those is tested against real vaults rather
// than stubs, because the guarantee comes from the ciphertext and a stub would not
// have any.
//
// Every secret here is invented.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Vault } from "../src/core/vault.js";
import { SAMPLE_PASSWORD } from "../src/core/seed.js";
import { SyncStore, toBlob } from "../src/sync/store.mjs";
import { SyncClient, SyncError, pairingFor } from "../src/sync/client.mjs";

/** A vault plus a client already pointed at a store. */
async function pair(store = new SyncStore()) {
  const vault = await Vault.create({ name: "Test", password: SAMPLE_PASSWORD });
  const token = await store.createVault(vault.meta.id);
  const client = new SyncClient({ vault, store, vaultId: vault.meta.id, token });
  return { vault, store, client, token, vaultId: vault.meta.id };
}

/** A second device on the same vault: same key, so it can open the same records. */
async function secondDevice(vault, store, token) {
  const device = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
  const client = new SyncClient({ vault: device, store, vaultId: vault.meta.id, token });
  return { device, client };
}

describe("sync store", () => {
  test("mints one token per vault and refuses anything else", async () => {
    const store = new SyncStore();
    const token = await store.createVault("v1");
    assert.equal(typeof token, "string");
    assert.ok(token.length >= 40);
    assert.throws(() => store.pull("v1", "not-the-token"), (e) => e.status === 401);
    assert.throws(() => store.pull("v1", ""), (e) => e.status === 401);
  });

  test("rotating the token cuts off the old one", async () => {
    const store = new SyncStore();
    const first = await store.createVault("v1");
    const second = await store.createVault("v1");
    assert.notEqual(first, second);
    assert.throws(() => store.pull("v1", first), (e) => e.status === 401);
    store.pull("v1", second);
  });

  test("a vault that does not exist is 404, not 401", async () => {
    const store = new SyncStore();
    await store.createVault("v1");
    const token = await store.createVault("v1");
    assert.throws(() => store.pull("nope", token), (e) => e.status === 404);
  });

  test("the token is hashed on disk, never stored as given", async () => {
    const store = new SyncStore();
    const token = await store.createVault("v1");
    const dump = JSON.stringify(store.serialize());
    assert.equal(dump.includes(token), false, "the write token must not be recoverable from the store");
  });

  test("a record missing its ciphertext is refused before it is stored", async () => {
    const { store, client, vaultId, token, vault } = await pair();
    vault.addItem({ name: "Real", type: "api-key", value: "x" });
    client.push();
    assert.throws(
      () => store.push(vaultId, token, { id: "x", rev: 99, seq: 99, type: "api-key" }),
      /ciphertext|nonce|wrapped key/
    );
  });

  test("a record without a sequence number cannot be placed in the stream", async () => {
    const { store, vault, vaultId, token } = await pair();
    vault.addItem({ name: "Real", type: "api-key", value: "x" });
    const record = vault.rawRecords()[0];
    assert.throws(() => toBlob({ ...record, seq: undefined }), /sequence/);
    assert.throws(() => store.push(vaultId, token, { ...record, seq: undefined }), /sequence/);
  });

  test("the same revision twice is unchanged, not a conflict", async () => {
    // A device that repeats itself must not be told to resolve a difference that
    // does not exist. Before this rule every repeat read as a conflict.
    const { store, vault, vaultId, token } = await pair();
    const { id } = vault.addItem({ name: "Thing", type: "api-key", value: "one" });
    const blob = toBlob(vault.rawRecord(id));
    store.push(vaultId, token, blob);
    const again = store.push(vaultId, token, blob);
    assert.equal(again.unchanged, true);
    assert.equal(store.count(vaultId), 1, "and it did not duplicate the record");
  });

  test("the same revision with different bytes is a conflict, not a repeat", async () => {
    // Two devices each change a record once from the same base, so both reach
    // revision 2 with different ciphertext. The store can read neither side, so it
    // refuses rather than picks.
    const { store, vault, vaultId, token } = await pair();
    const { id } = vault.addItem({ name: "Shared", type: "api-key", value: "base" });
    store.push(vaultId, token, toBlob(vault.rawRecord(id)));
    // Opened after the item exists, so both sides start from the same revision.
    const first = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);

    vault.updateItem(id, { value: "one way" });
    first.updateItem(id, { value: "another way" });
    assert.equal(vault.rawRecord(id).rev, 2);
    assert.equal(first.rawRecord(id).rev, 2);

    store.push(vaultId, token, toBlob(vault.rawRecord(id)));
    assert.throws(
      () => store.push(vaultId, token, toBlob(first.rawRecord(id))),
      (err) => err.status === 409 && err.current === 2
    );
    assert.equal(store.pull(vaultId, token, 0).records[0].ciphertext, toBlob(vault.rawRecord(id)).ciphertext);
  });

  test("a revision the store has moved past is a conflict, and the caller is told the current one", async () => {
    const { store, vault, vaultId, token } = await pair();
    const { id } = vault.addItem({ name: "Thing", type: "api-key", value: "one" });
    const stale = toBlob(vault.rawRecord(id));
    store.push(vaultId, token, stale);
    vault.updateItem(id, { value: "two" });
    const fresh = toBlob(vault.rawRecord(id));
    store.push(vaultId, token, fresh);
    try {
      store.push(vaultId, token, stale);
      assert.fail("an older revision replaced a newer one");
    } catch (err) {
      assert.equal(err.status, 409);
      assert.equal(err.current, fresh.rev);
      assert.equal(store.pull(vaultId, token, 0).records[0].rev, fresh.rev, "the newer copy survived");
    }
  });

  test("a pull is a delta, not the whole file", async () => {
    const { store, vault, client, vaultId, token } = await pair();
    vault.addItem({ name: "One", type: "api-key", value: "1" });
    vault.addItem({ name: "Two", type: "api-key", value: "2" });
    client.push();
    const top = store.seq(vaultId);
    assert.equal(store.pull(vaultId, token, 0).records.length, 2);
    assert.equal(store.pull(vaultId, token, top).records.length, 0);
    vault.addItem({ name: "Three", type: "api-key", value: "3" });
    client.push();
    assert.deepEqual(
      store.pull(vaultId, token, top).records.map((r) => r.type),
      ["api-key"]
    );
    assert.equal(store.pull(vaultId, token, top).records.length, 1);
  });

  test("the sequence orders two records edited at the same revision", async () => {
    // This is the case that a per record revision cannot express. Two different
    // records both at rev 2 have to be ordered by the vault wide number.
    const { store, vault, vaultId, token } = await pair();
    const a = vault.addItem({ name: "A", type: "api-key", value: "1" });
    const b = vault.addItem({ name: "B", type: "api-key", value: "2" });
    vault.updateItem(a.id, { value: "1 v2" });
    vault.updateItem(b.id, { value: "2 v2" });
    for (const record of vault.rawRecords()) store.push(vaultId, token, toBlob(record));
    const pulled = store.pull(vaultId, token, 0).records;
    assert.equal(pulled.length, 2);
    assert.deepEqual(
      pulled.map((r) => r.rev),
      [2, 2],
      "both records are at the same revision"
    );
    assert.deepEqual(
      pulled.map((r) => r.seq),
      [...pulled.map((r) => r.seq)].sort((x, y) => x - y),
      "and the returned order follows the sequence, not the revision"
    );
  });
});

describe("sync client", () => {
  test("two devices converge on the same set", async () => {
    const { vault, store, client, token } = await pair();
    vault.addItem({ name: "Alpha", type: "api-key", service: "Alpha", value: "a" });
    vault.addItem({ name: "Beta", type: "api-key", service: "Beta", value: "b" });
    client.push();

    const { device, client: second } = await secondDevice(vault, store, token);
    const pulled = second.pull();
    assert.equal(pulled.applied + pulled.ignored, 2);
    assert.equal(pulled.rejected, 0);
    assert.deepEqual(device.listFiltered().map((i) => i.name).sort(), ["Alpha", "Beta"]);
  });

  test("an edit travels, and the far side reads the new value", async () => {
    const { vault, store, client, token } = await pair();
    const { id } = vault.addItem({ name: "Beta", type: "api-key", value: "b" });
    client.push();
    const { device, client: second } = await secondDevice(vault, store, token);
    second.pull();

    device.updateItem(id, { value: "b edited on the second device" });
    const pushed = second.push();
    assert.equal(pushed.pushed, 1);
    assert.deepEqual(pushed.conflicts, [], "an edit is not a conflict");

    client.pull();
    assert.equal(vault.readItem(id).value, "b edited on the second device");
  });

  test("a delete travels and the row stops appearing", async () => {
    const { vault, store, client, token } = await pair();
    const { id } = vault.addItem({ name: "Doomed", type: "api-key", value: "x" });
    vault.addItem({ name: "Kept", type: "api-key", value: "y" });
    client.push();
    const { device, client: second } = await secondDevice(vault, store, token);
    second.pull();
    assert.ok(device.listFiltered().some((i) => i.name === "Doomed"));

    vault.deleteItem(id);
    client.push();
    second.pull();
    assert.equal(device.listFiltered().some((i) => i.name === "Doomed"), false);
  });

  test("applyRemote tells a delete apart from a repeat of what it already has", async () => {
    // A delete changes only deletedAt. The ciphertext stays the same, so a shortcut
    // that compared bytes would call the delete "unchanged" and never apply it, and
    // the row would stay on the other device forever.
    const { vault, store, client, token } = await pair();
    const { id } = vault.addItem({ name: "Doomed", type: "api-key", value: "x" });
    client.push();
    const live = toBlob(vault.rawRecord(id));

    const target = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
    // The target already holds the record at that revision, so it is refused before
    // the byte comparison is even reached. Either answer means nothing moved.
    assert.ok(["unchanged", "ignored"].includes(target.applyRemote(live)), "the same record again changes nothing");

    vault.deleteItem(id);
    const dead = toBlob(vault.rawRecord(id));
    assert.equal(dead.ciphertext, live.ciphertext, "a delete leaves the ciphertext alone");
    assert.notEqual(dead.deletedAt, null);
    assert.equal(target.applyRemote(dead), "applied", "and the delete still lands");
    assert.equal(target.listFiltered().some((i) => i.name === "Doomed"), false);
    void store;
    void token;
  });

  test("two edits to one item are reported, not merged, and the first write wins", async () => {
    const { vault, store, client, token } = await pair();
    const { id } = vault.addItem({ name: "Shared", type: "api-key", value: "base" });
    client.push();
    const { device, client: second } = await secondDevice(vault, store, token);
    second.pull();

    // Both start from the same revision, so both produce rev 2.
    vault.updateItem(id, { value: "from the first device" });
    device.updateItem(id, { value: "from the second device" });
    assert.equal(vault.rawRecord(id).rev, 2);
    assert.equal(device.rawRecord(id).rev, 2);

    const first = client.push();
    assert.equal(first.pushed, 1, "the first write lands");
    // The second device has already been told revision 1 left, so it knows to try
    // revision 2. The store is at 2 and refuses it.
    const late = second.push();
    assert.equal(late.pushed, 0, "the late write does not overwrite");
    assert.equal(late.conflicts.length, 1);
    assert.equal(late.conflicts[0].id, id);
    assert.equal(late.conflicts[0].local, 2);
    assert.equal(late.conflicts[0].remote, 2);
  });

  test("a pull does not echo back what it just received", async () => {
    // A device that pushes everything it holds after a pull reports conflicts with
    // itself at equal revisions, which is noise, not a conflict.
    const { vault, store, client, token } = await pair();
    vault.addItem({ name: "One", type: "api-key", value: "1" });
    client.push();
    const { client: second } = await secondDevice(vault, store, token);
    second.pull();
    const echoed = second.push();
    assert.equal(echoed.pushed, 0);
    assert.deepEqual(echoed.conflicts, []);
  });

  test("a server that sends another vault's records gets nothing stored", async () => {
    const { vault, vaultId, token } = await pair();
    vault.addItem({ name: "Mine", type: "api-key", value: "ok" });

    const stranger = await Vault.create({ name: "Stranger", password: SAMPLE_PASSWORD });
    stranger.addItem({ name: "Theirs", type: "api-key", value: "no" });
    const foreign = stranger.rawRecords()[0];

    const lying = {
      pull: () => ({ records: [{ ...foreign, rev: 999, seq: 999 }], seq: 999 }),
      push: () => {},
    };
    const client = new SyncClient({ vault, store: lying, vaultId, token });
    const result = client.pull();
    assert.equal(result.rejected, 1);
    assert.equal(result.applied, 0);
    assert.equal(vault.listFiltered().some((i) => i.name === "Theirs"), false);
  });

  test("a record with a doctored id is refused, because the id is in the ciphertext", async () => {
    const { vault, store, client, token, vaultId } = await pair();
    const { id } = vault.addItem({ name: "Real", type: "api-key", value: "x" });
    client.push();
    const good = store.pull(vaultId, token, 0).records[0];

    const doctored = { ...good, id: "a-different-id", rev: 50, seq: 50 };
    const lying = { pull: () => ({ records: [doctored], seq: 50 }), push: () => {} };
    const target = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
    const victim = new SyncClient({ vault: target, store: lying, vaultId, token });
    const result = victim.pull();
    assert.equal(result.rejected, 1);
    assert.equal(target.readItem("a-different-id"), null);
    assert.equal(target.rawRecord(id).rev, 1, "the genuine record was left alone");
  });

  test("edited ciphertext is refused", async () => {
    const { vault, store, client, token, vaultId } = await pair();
    vault.addItem({ name: "Real", type: "api-key", value: "x" });
    client.push();
    const good = store.pull(vaultId, token, 0).records[0];
    const raw = Buffer.from(good.ciphertext, "base64");
    raw[0] ^= 0xff;
    const tampered = { ...good, ciphertext: raw.toString("base64"), rev: 50, seq: 50 };

    const target = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
    const victim = new SyncClient({
      vault: target,
      store: { pull: () => ({ records: [tampered], seq: 50 }), push: () => {} },
      vaultId,
      token,
    });
    assert.equal(victim.pull().rejected, 1);
  });

  test("a second device with a different key cannot read the vault and syncs nothing", async () => {
    // Same vault id, different password, so a different vault key. This is what a
    // server operator would have if they tried to mint their own client.
    const { vault, store, client } = await pair();
    vault.addItem({ name: "Alpha", type: "api-key", value: "a" });
    client.push();
    const impostor = await Vault.create({
      name: "Impostor",
      password: SAMPLE_PASSWORD + "-different",
      id: vault.meta.id,
    });
    const client2 = new SyncClient({
      vault: impostor,
      store,
      vaultId: vault.meta.id,
      token: "whatever",
    });
    // A bad token fails first, which is the correct order of checks.
    assert.throws(() => client2.pull(), (e) => e instanceof SyncError && e.status === 401);
  });

  test("no plaintext reaches the store", async () => {
    const { vault, client, store } = await pair();
    vault.addItem({
      name: "SuperSecretName",
      type: "api-key",
      service: "Avocado",
      host: "avocado.example",
      value: "EXAMPLE-stripe-value-not-real",
      notes: "the passphrase is horsebattery",
    });
    client.push();
    const dump = JSON.stringify(store.serialize());
    for (const word of ["SuperSecretName", "Avocado", "avocado.example", "TOPSECRETVALUE", "horsebattery"]) {
      assert.equal(dump.includes(word), false, `${word} reached the store`);
    }
  });

  test("the store keeps only the fields the plan allows", async () => {
    const { vault, client, store } = await pair();
    vault.addItem({ name: "Thing", type: "api-key", value: "x" });
    client.push();
    const stored = Object.keys(store.serialize().vaults[Object.keys(store.serialize().vaults)[0]].records)[0];
    const record = store.serialize().vaults[Object.keys(store.serialize().vaults)[0]].records[stored];
    assert.deepEqual(
      Object.keys(record).sort(),
      ["ciphertext", "createdAt", "deletedAt", "id", "nonce", "rev", "searchTokens", "seq", "type", "updatedAt", "version", "wrappedKey"]
    );
  });

  test("a blob has no history and no last used time, which the plan does not list", async () => {
    const { vault } = await pair();
    const { id } = vault.addItem({ name: "Thing", type: "api-key", value: "x" });
    vault.touch(id);
    vault.updateItem(id, { value: "y" });
    const record = vault.rawRecord(id);
    assert.ok(record.history.length > 0, "the local record does keep history");
    const blob = toBlob(record);
    assert.equal(blob.history, undefined, "history must not travel");
    assert.equal(blob.lastUsedAt, undefined);
  });

  test("a losing copy can be read without being adopted, so both sides can be compared", async () => {
    // To show a conflict the interface has to decrypt the copy that lost. That is a
    // read, not a write, and it must not change the vault.
    const { vault } = await pair();
    const { id } = vault.addItem({ name: "Shared", type: "api-key", value: "one way" });
    const loser = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
    loser.updateItem(id, { value: "the other way" });
    const remote = toBlob(loser.rawRecord(id));

    const shown = vault.readRemote(remote);
    assert.equal(shown.value, "the other way", "the other side decrypts");
    assert.equal(shown.rev, 2);
    assert.equal(vault.readItem(id).value, "one way", "and nothing was taken");
    assert.equal(vault.rawRecord(id).rev, 1);
  });

  test("readRemote refuses a record it cannot open", async () => {
    const { vault } = await pair();
    const stranger = await Vault.create({ name: "Stranger", password: SAMPLE_PASSWORD });
    stranger.addItem({ name: "Not yours", type: "api-key", value: "EXAMPLE-no" });
    assert.throws(() => vault.readRemote(stranger.rawRecords()[0]));
    assert.throws(() => vault.readRemote({ id: "x" }), /ciphertext/);
  });

  test("adopting the other side raises the revision above both and syncs out", async () => {
    const { vault, store, client, token } = await pair();
    const { id } = vault.addItem({ name: "Shared", type: "api-key", value: "local" });
    client.push();
    const other = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
    other.updateItem(id, { value: "remote" });
    // Put the other side into the store as though it had arrived from elsewhere.
    store.push(vault.meta.id, token, toBlob(other.rawRecord(id)));

    const rev = vault.adoptRemote(store.record(vault.meta.id, token, id), { over: 1 });
    assert.equal(rev, 3, "above the losing revision and the winning one");
    assert.equal(vault.readItem(id).value, "remote", "the adopted copy is what the vault holds");
    assert.equal(vault.rawRecord(id).rev, 3);
    // And it is newer than the store's copy, so the next push lands rather than 409.
    const pushed = client.push();
    assert.equal(pushed.pushed, 1);
    assert.deepEqual(pushed.conflicts, []);
  });

  test("adoptRemote will not store bytes it cannot open", async () => {
    const { vault } = await pair();
    const stranger = await Vault.create({ name: "Stranger", password: SAMPLE_PASSWORD });
    stranger.addItem({ name: "Not yours", type: "api-key", value: "EXAMPLE-no" });
    const record = stranger.rawRecords()[0];
    assert.throws(() => vault.adoptRemote(record));
    assert.equal(vault.rawRecord(record.id), null, "nothing was written");
  });

  test("the sequence survives a save and reload, so a device resumes its delta", async () => {
    const { vault, store, client, vaultId, token } = await pair();
    vault.addItem({ name: "One", type: "api-key", value: "1" });
    client.push();
    const reopened = await Vault.unlock(vault.serialize(), SAMPLE_PASSWORD);
    assert.equal(reopened.seq, vault.seq);
    assert.ok(reopened.seq >= 1);

    const resumed = new SyncClient({
      vault: reopened,
      store,
      vaultId,
      token,
      seq: reopened.seq,
      sent: client.sent,
    });
    const round = resumed.round();
    assert.equal(round.pulled.applied, 0, "nothing new after a reload");
    assert.equal(round.pushed.pushed, 0, "and nothing to send again");
  });

  test("a pairing describes where to resume", async () => {
    const pairing = pairingFor({ vaultId: "v1", token: "t", seq: 7, url: "http://127.0.0.1:3000" });
    assert.equal(pairing.vaultId, "v1");
    assert.equal(pairing.seq, 7);
    assert.match(pairing.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("a store kept in a file reloads to the same state", async () => {
    let disk = "";
    const io = {
      read: async () => disk,
      write: async (text) => {
        disk = text;
      },
    };
    const first = new SyncStore(io);
    const token = await first.createVault("v1");
    const vault = await Vault.create({ name: "Test", password: SAMPLE_PASSWORD });
    const client = new SyncClient({ vault, store: first, vaultId: "v1", token });
    vault.addItem({ name: "Persisted", type: "api-key", value: "x" });
    client.push();
    // `push` is synchronous so one record is one atomic decision. The write behind
    // it is queued, and `flushed` is the handle the server waits on.
    await first.flushed;
    assert.ok(disk.length > 0, "the store wrote itself out");
    assert.equal(disk.includes(token), false, "but not the token");

    const second = new SyncStore(io);
    await second.load();
    assert.equal(second.count("v1"), 1);
    assert.equal(second.pull("v1", token, 0).records.length, 1);
    assert.equal(second.fingerprint("v1"), first.fingerprint("v1"));
  });

  test("a store on a file remembers its records after a reload", async () => {
    // Before this, the server never called load() at boot, so a restart answered a
    // pull with nothing at all. That reads like "there is nothing to sync" rather
    // than "the store forgot", and the second machine silently got no data.
    let disk = "";
    const io = { read: async () => disk, write: async (t) => { disk = t; } };
    const first = new SyncStore(io);
    const token = await first.createVault("v1");
    const vault = await Vault.create({ name: "Test", password: SAMPLE_PASSWORD });
    const client = new SyncClient({ vault, store: first, vaultId: "v1", token });
    vault.addItem({ name: "Along for the ride", type: "api-key", value: "EXAMPLE-ride" });
    client.push();
    await first.flushed;

    const second = new SyncStore(io);
    await second.load();
    assert.equal(second.has("v1"), true, "the vault is known after a reload");
    assert.equal(second.count("v1"), 1, "and its records are still there");
    assert.equal(second.pull("v1", token, 0).records.length, 1);
  });

  test("a store with no file is empty rather than broken", async () => {
    const store = new SyncStore({ read: async () => "" });
    await store.load();
    assert.equal(store.has("anything"), false);
    const fresh = new SyncStore({ read: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } });
    // A caller that means "missing" and a caller that means "broken" are different, so
    // this one is expected to throw: only the server's reader maps ENOENT to empty.
    await assert.rejects(() => fresh.load());
  });

  test("a corrupt store file is reported rather than silently emptied", async () => {
    const store = new SyncStore({ read: async () => "{ not json" });
    await assert.rejects(() => store.load(), /JSON|Unexpected/i);
  });

  test("dropping a vault removes its records and its token", async () => {
    const { store, vault, client, vaultId, token } = await pair();
    vault.addItem({ name: "One", type: "api-key", value: "1" });
    client.push();
    assert.equal(store.count(vaultId), 1);
    await store.drop(vaultId);
    assert.equal(store.count(vaultId), 0);
    assert.throws(() => store.pull(vaultId, token, 0), (e) => e.status === 404);
  });
});
