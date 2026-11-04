// A sync store: the part of sync that holds other people's ciphertext.
//
// It is deliberately stupid. It receives a record, checks that the caller is
// allowed to write that vault, and puts the bytes where they belong. It cannot
// read a name, a note or a value, and it has no key to try.
//
// What it does know, because routing needs it: the vault id, the record id, the
// revision number, the record type, and the timestamps. PLAN.md section 4 lists
// exactly these and says nothing else is kept in clear. Anything else would be a
// claim this file could not keep.
//
// One process, one JSON file, no dependencies. It is a reference implementation
// of the contract, not a hosted service.

import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";

/** Compare two strings without leaking where they differ. */
function same(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * The fields that travel. Everything else on a record is stripped here rather
 * than at the call site, so a caller cannot accidentally send more.
 */
const ALLOWED = ["id", "type", "rev", "seq", "version", "createdAt", "updatedAt", "deletedAt", "wrappedKey", "ciphertext", "nonce", "searchTokens"];

/**
 * Reduce a full vault record to what sync carries.
 * @param {object} record
 */
export function toBlob(record) {
  const out = {};
  for (const key of ALLOWED) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  if (!out.id) throw new Error("a record needs an id to sync");
  if (!Number.isInteger(out.rev) || out.rev < 1) throw new Error("a record needs a rev of 1 or more to sync");
  if (!Number.isInteger(out.seq) || out.seq < 1) {
    // `seq` is the vault wide change counter. `rev` is per record. A pull cursor has
    // to be the first, because a per record number cannot order two different
    // records. A record without it cannot be placed in the stream.
    throw new Error("a record needs its vault sequence number to sync");
  }
  if (!out.ciphertext || !out.nonce || !out.wrappedKey) {
    throw new Error("a record needs its ciphertext, nonce and wrapped key to sync");
  }
  if (!Array.isArray(out.searchTokens)) {
    // The blind index travels with the record so a second device can search
    // without re-encrypting. It leaks token equality, which PLAN.md records as a
    // deliberate tradeoff. Refusing a record without it keeps every stored record
    // searchable, so no device silently returns half a result set.
    throw new Error("a record needs its search tokens to sync");
  }
  return out;
}

/** A store kept in memory, with an optional file behind it. */
export class SyncStore {
  #vaults = new Map();
  #tokens = new Map();

  /**
   * @param {{path?: string, read?: Function, write?: Function}} [io]
   */
  constructor(io = {}) {
    this.io = io;
    /** Resolves when the last queued write landed. */
    this.flushed = Promise.resolve();
    /** The last write failure, if any. */
    this.lastError = null;
  }

  /** Load from disk if there is a file. Broken JSON is reported, not swallowed. */
  async load() {
    if (!this.io.read) return this;
    const raw = await this.io.read();
    if (!raw) return this;
    const data = JSON.parse(raw);
    for (const [id, vault] of Object.entries(data.vaults || {})) {
      this.#vaults.set(id, new Map(Object.entries(vault.records || {})));
    }
    for (const [id, token] of Object.entries(data.tokens || {})) {
      this.#tokens.set(id, token);
    }
    return this;
  }

  /** Persist. Returns the JSON so a test can read it without a file. */
  async save() {
    const data = this.serialize();
    if (this.io.write) await this.io.write(JSON.stringify(data, null, 2));
    return data;
  }

  serialize() {
    const vaults = {};
    for (const [id, records] of this.#vaults) {
      vaults[id] = { records: Object.fromEntries(records) };
    }
    return { vaults, tokens: Object.fromEntries(this.#tokens) };
  }

  /**
   * Mint a write token for a vault. The caller shows this once and stores it.
   * Returns the token, never anything derived from it.
   */
  async createVault(vaultId) {
    if (!vaultId || typeof vaultId !== "string") throw new Error("a vault id is required");
    if (!this.#vaults.has(vaultId)) this.#vaults.set(vaultId, new Map());
    // A second call rotates the token rather than adding one. One writer token per
    // vault keeps the rule simple: the newest pairing wins, and an old device is
    // cut off rather than left with a live credential nobody remembers.
    const token = randomBytes(32).toString("base64url");
    this.#tokens.set(vaultId, createHash("sha256").update(token, "utf8").digest("hex"));
    await this.save();
    return token;
  }

  /** True when the token opens this vault. */
  #allowed(vaultId, token) {
    const stored = this.#tokens.get(vaultId);
    if (!stored || !token) return false;
    const given = createHash("sha256").update(String(token), "utf8").digest("hex");
    return same(stored, given);
  }

  /** True when a vault exists at all. Used to tell 404 from 401. */
  has(vaultId) {
    return this.#vaults.has(vaultId);
  }

  /**
   * Every record changed after a point in the vault sequence.
   *
   * `since` is the highest `seq` the caller has already applied. A caller with
   * nothing stored asks for 0 and gets everything. The sequence is vault wide, so
   * "everything after 41" is a clean cut with no gaps and no repeats. `rev` is per
   * record and cannot do this job: two records can both be at rev 2.
   * @param {string} vaultId
   * @param {string} token
   * @param {number} since
   */
  pull(vaultId, token, since = 0) {
    if (!this.has(vaultId)) throw Object.assign(new Error("no such vault"), { status: 404 });
    if (!this.#allowed(vaultId, token)) throw Object.assign(new Error("bad token"), { status: 401 });
    const records = this.#vaults.get(vaultId);
    const changes = [...records.values()].filter((r) => r.seq > since);
    const seq = this.seq(vaultId);
    return { records: changes.sort((a, b) => a.seq - b.seq), seq };
  }

  /** The highest point in the vault sequence this store holds. */
  seq(vaultId) {
    const records = this.#vaults.get(vaultId) || new Map();
    let top = 0;
    for (const r of records.values()) if (r.seq > top) top = r.seq;
    return top;
  }

  /**
   * Apply one record.
   *
   * Last write wins on the record revision, which is the rule PLAN.md states. A
   * record whose rev is at or below the stored one is refused with 409 and the
   * caller keeps its own copy. The server never merges, because it cannot read
   * either side.
   *
   * The comparison is on `rev`, never `seq`. Two records can share a seq meaning
   * nothing, but two copies of one record are ordered by rev.
   *
   * @param {string} vaultId
   * @param {string} token
   * @param {object} record
   */
  push(vaultId, token, record) {
    if (!this.has(vaultId)) throw Object.assign(new Error("no such vault"), { status: 404 });
    if (!this.#allowed(vaultId, token)) throw Object.assign(new Error("bad token"), { status: 401 });
    const blob = toBlob(record);
    const records = this.#vaults.get(vaultId);
    const current = records.get(blob.id);
    // An equal revision is one of two things, and the bytes say which.
    //
    // Identical ciphertext is the same record arriving twice, which happens when a
    // device repeats itself. Reporting that as a conflict would ask a user to
    // resolve a difference that does not exist.
    //
    // Different ciphertext at the same revision is the real clash: two devices each
    // changed the record once from the same base, so both reached revision 2. The
    // store cannot merge them, because it can read neither. It refuses and reports
    // the current revision, and the caller keeps its own copy.
    if (current && blob.rev === current.rev) {
      const sameBytes =
        current.ciphertext === blob.ciphertext &&
        current.nonce === blob.nonce &&
        current.wrappedKey === blob.wrappedKey;
      if (sameBytes) return { stored: blob.id, rev: blob.rev, seq: blob.seq, unchanged: true };
      throw Object.assign(new Error("the same revision, different contents"), {
        status: 409,
        current: current.rev,
      });
    }
    if (current && blob.rev < current.rev) {
      throw Object.assign(new Error("an older revision"), { status: 409, current: current.rev });
    }
    records.set(blob.id, blob);
    // Persist per write. `push` stays synchronous so one record is one atomic
    // decision, and the write is queued behind it. A failure surfaces as an
    // unhandled rejection on `flushed`, which the server checks per request rather
    // than swallowing.
    this.flushed = this.flushed.then(() => this.save()).catch((err) => {
      this.lastError = err;
      throw err;
    });
    return { stored: blob.id, rev: blob.rev, seq: blob.seq };
  }

  /** Delete a vault and its token. For a test, and for a user who asks. */
  async drop(vaultId) {
    this.#vaults.delete(vaultId);
    this.#tokens.delete(vaultId);
    await this.save();
  }

  /** A vault's size, in records. For an operator, and for a test. */
  count(vaultId) {
    const records = this.#vaults.get(vaultId);
    return records ? records.size : 0;
  }

  /**
   * A stable fingerprint of a vault's contents, for checking that two stores agree.
   * Hashes ids and revisions only, never the bytes, so it is cheap to log.
   */
  fingerprint(vaultId) {
    const records = this.#vaults.get(vaultId);
    if (!records) return null;
    const list = [...records.values()]
      .map((r) => `${r.id}:${r.rev}:${r.seq}:${r.deletedAt ? "d" : "l"}`)
      .sort()
      .join("\n");
    return createHmac("sha256", "hasp-sync-fingerprint").update(list, "utf8").digest("base64url").slice(0, 22);
  }
}
