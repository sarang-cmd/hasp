// The vault.
//
// What reaches disk: a wrapped vault key, per-item wrapped item keys, item
// ciphertexts, and a blind search index. What never reaches disk: the master
// password, the password key, the vault key and any plaintext field.
//
// The blind index follows plan section 4. Tokens are normalised, then hashed
// with HMAC under a key derived from the vault key, so a stored record can be
// matched against a search query without the record holding readable text.

import { randomUUID, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { deriveKey, newSalt, kdfParams } from "./kdf.js";
import { seal, open, newItemKey } from "./crypto.js";
import { wrapKey, unwrapKey } from "./wrap.js";

export const TYPES = ["api-key", "backup-codes", "totp", "note"];
export const ENVIRONMENTS = ["prod", "staging", "live", "dev", ""];

/** Derive the blind index key. Distinct from every other key in the system. */
export function searchKey(vaultKey) {
  return Buffer.from(hkdfSync("sha256", vaultKey, Buffer.alloc(0), "hasp:search:v1", 32));
}

/**
 * Normalise one token. Lowercase, strip punctuation, drop filler words.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeToken(raw) {
  return String(raw)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
}

/**
 * Build the token list for an item: name words, service, host labels, type, env.
 * @param {object} item plaintext fields
 * @returns {string[]} unique normalised tokens
 */
export function tokensFor(item) {
  const words = [];
  const push = (v) => {
    if (!v) return;
    for (const part of String(v).split(/[^\p{L}\p{N}]+/u)) {
      const t = normalizeToken(part);
      if (t.length >= 2) words.push(t);
    }
  };
  push(item.name);
  push(item.service);
  push(item.host);
  push(item.issuer);
  push(item.account);
  for (const tag of item.tags || []) push(tag);
  for (const note of [item.notes]) push(note);
  const out = new Set(words);
  if (item.type) out.add(`t${normalizeToken(item.type)}`);
  if (item.env) out.add(`e${normalizeToken(item.env)}`);
  if (item.brand) out.add(`b${normalizeToken(item.brand)}`);
  return [...out];
}

/** HMAC every token under the blind index key. */
export function blindTokens(vaultKey, plaintext) {
  const key = searchKey(vaultKey);
  return tokensFor(plaintext).map((t) =>
    createHmac("sha256", key).update(t, "utf8").digest("base64url")
  );
}

/** Hash a user query the same way, so it can be matched against stored tokens. */
export function blindQuery(vaultKey, query) {
  const key = searchKey(vaultKey);
  return String(query)
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeToken)
    .filter((t) => t.length >= 2)
    .map((t) => createHmac("sha256", key).update(t, "utf8").digest("base64url"));
}

/**
 * An unlocked vault. Holds the vault key in memory for the life of the object.
 * Call lock() when done; it zeroes what it can.
 */
export class Vault {
  #vaultKey;
  #items;
  #meta;
  // A vault wide counter, separate from each record's own `version` and `rev`.
  // It answers "what changed since revision N" for the whole vault, which is what
  // a device needs in order to ask for the delta rather than the whole file.
  #seq;

  /**
   * @param {object} meta stored metadata: id, name, kdf, salt, wrapped, nonce, createdAt
   * @param {Buffer} vaultKey
   * @param {Map<string, object>} items stored records, ciphertext only
   */
  constructor(meta, vaultKey, items = new Map()) {
    this.#meta = meta;
    this.#vaultKey = vaultKey;
    this.#items = items;
    this.#seq = Number.isInteger(meta.seq) ? meta.seq : 0;
  }

  /** The vault wide change counter. Every write moves it. */
  get seq() {
    return this.#seq;
  }

  /** Take the next value in the vault wide sequence. */
  #nextSeq() {
    this.#seq += 1;
    this.#meta.seq = this.#seq;
    return this.#seq;
  }

  /**
   * Create a new empty vault under a master password.
   * @param {{name: string, password: string}} opts
   * @returns {Promise<Vault>}
   */
  static async create({ name, password, id = randomUUID() }) {
    if (String(password).length < 12) {
      throw new Error("master password must be at least 12 characters");
    }
    const salt = newSalt();
    const params = kdfParams();
    const passwordKey = await deriveKey(password, salt, params);
    const vaultKey = randomBytes(32);
    const wrapped = wrapKey(passwordKey, vaultKey);
    passwordKey.fill(0);
    const meta = {
      id,
      name,
      kdf: params,
      salt: salt.toString("base64"),
      wrapped: wrapped.wrapped,
      nonce: wrapped.nonce,
      passkeyWrapped: null,
      createdAt: new Date().toISOString(),
    };
    return new Vault(meta, vaultKey);
  }

  /**
   * Unlock an existing vault. Throws with a flat message on a wrong password.
   * @param {object} stored {meta, items}
   * @param {string} password
   */
  static async unlock(stored, password) {
    const { meta } = stored;
    const salt = Buffer.from(meta.salt, "base64");
    const passwordKey = await deriveKey(password, salt, meta.kdf);
    let vaultKey;
    try {
      vaultKey = unwrapKey(passwordKey, { wrapped: meta.wrapped, nonce: meta.nonce });
    } catch {
      // Never distinguish a wrong password from a damaged wrap.
      throw new Error("Wrong master password");
    } finally {
      passwordKey.fill(0);
    }
    const items = new Map(Object.entries(stored.items || {}));
    return new Vault(meta, vaultKey, items);
  }

  /** Non-secret metadata, safe to send to the client. */
  get meta() {
    const { password, ...safe } = this.#meta;
    return { ...safe };
  }

  /** How many live items. */
  get size() {
    return [...this.#items.values()].filter((r) => !r.deletedAt).length;
  }

  /**
   * Add an item. Fields are encrypted before they leave this method.
   * @param {object} fields plaintext item fields
   * @returns {{id: string}}
   */
  addItem(fields) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const payload = cleanItem(fields);
    const itemKey = newItemKey();
    const version = 1;
    const body = seal(itemKey, payload, { vaultId: this.#meta.id, itemId: id, version });
    const wrappedKey = wrapKey(this.#vaultKey, itemKey);
    const record = {
      id,
      type: payload.type,
      // `version` is bound into the ciphertext as additional data, so it can only
      // change by re-sealing the payload. A delete or a restore changes the record
      // without touching the payload, so the two cannot share one counter.
      // `rev` is the record's own revision: it moves on every change, including the
      // ones that leave the ciphertext alone. Sync compares it, and it is the only
      // number the server is allowed to see.
      rev: 1,
      seq: this.#nextSeq(),
      version,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      wrappedKey,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      searchTokens: blindTokens(this.#vaultKey, payload),
    };
    this.#items.set(id, record);
    return { id };
  }

  /**
   * Replace an item's fields, bumping its version.
   * The old ciphertext is kept as one previous version, which is what makes the
   * "rotate" flow reviewable.
   * @param {string} id
   * @param {object} fields
   */
  updateItem(id, fields) {
    const record = this.#items.get(id);
    if (!record) throw new Error("item not found");
    const payload = cleanItem({ ...this.readItem(id), ...fields });
    const itemKey = newItemKey();
    const version = record.version + 1;
    const body = seal(itemKey, payload, { vaultId: this.#meta.id, itemId: id, version });
    const wrappedKey = wrapKey(this.#vaultKey, itemKey);
    const history = record.history || [];
    history.push({
      version: record.version,
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      wrappedKey: record.wrappedKey,
      updatedAt: record.updatedAt,
    });
    this.#items.set(id, {
      ...record,
      type: payload.type,
      rev: (record.rev || 1) + 1,
      seq: this.#nextSeq(),
      version,
      updatedAt: new Date().toISOString(),
      wrappedKey,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      searchTokens: blindTokens(this.#vaultKey, payload),
      history: history.slice(-5),
    });
  }

  /**
   * Accept a record that arrived from somewhere else, after proving it is genuine.
   *
   * The check is not a signature. It is a decryption: unwrapping the record's key
   * needs the vault key, and opening the payload needs the vault id, the item id
   * and the version, all three bound into the ciphertext as additional data. A
   * record from another vault fails, a record with a doctored id fails, and a
   * record whose bytes were edited fails. That is why an untrusted server can be
   * handed this data and cannot smuggle anything in.
   *
   * @param {object} record a record as it came over the wire
   * @returns {"applied"|"ignored"} ignored when the local copy is already newer
   */
  applyRemote(record) {
    if (!record || typeof record !== "object") throw new Error("a record is required");
    if (!record.id || !record.ciphertext || !record.nonce || !record.wrappedKey) {
      throw new Error("a record is missing its ciphertext");
    }
    const local = this.#items.get(record.id);
    if (local && (local.rev || 1) >= (record.rev || 1)) return "ignored";
    // A vault cannot pull its own records and gain anything, but the store hands
    // them back to the device that wrote them, so the common case is the identical
    // record. Calling that "applied" would report every round as work when nothing
    // moved.
    //
    // Every field that carries meaning is compared, not just the ciphertext. A
    // delete leaves the ciphertext alone and changes only deletedAt, so a check on
    // the bytes would have reported a delete as no change and never applied it.
    if (
      local &&
      local.ciphertext === record.ciphertext &&
      local.nonce === record.nonce &&
      local.wrappedKey === record.wrappedKey &&
      (local.deletedAt ?? null) === (record.deletedAt ?? null) &&
      local.version === record.version
    ) {
      return "unchanged";
    }
    if (Number.isInteger(record.seq) && record.seq > this.#seq) {
      this.#seq = record.seq;
      this.#meta.seq = record.seq;
    }

    // Prove it before storing it. A failed open throws, and nothing is written.
    const itemKey = unwrapKey(this.#vaultKey, record.wrappedKey);
    open(itemKey, record, { vaultId: this.#meta.id, itemId: record.id, version: record.version });

    this.#items.set(record.id, {
      id: record.id,
      type: record.type,
      rev: record.rev,
      // The record carries the sender's place in the vault sequence. Adopting it
      // keeps the counter monotonic across devices, so the next local write does
      // not reuse a number another device already used.
      seq: Number.isInteger(record.seq) ? record.seq : this.#nextSeq(),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt ?? null,
      wrappedKey: record.wrappedKey,
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      searchTokens: Array.isArray(record.searchTokens) ? record.searchTokens : [],
    });
    return "applied";
  }

  /** Soft delete. A deleted item keeps its record so the change can sync. */
  deleteItem(id) {
    const record = this.#items.get(id);
    if (!record) throw new Error("item not found");
    this.#items.set(id, {
      ...record,
      rev: (record.rev || 1) + 1,
      seq: this.#nextSeq(),
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Restore a soft deleted item. */
  restoreItem(id) {
    const record = this.#items.get(id);
    if (!record) throw new Error("item not found");
    this.#items.set(id, {
      ...record,
      rev: (record.rev || 1) + 1,
      seq: this.#nextSeq(),
      deletedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Deleted items, newest deletion first.
   *
   * A delete keeps the record so the change can sync, which means the data is still
   * there. Without a way to read it, the delete confirmation's promise that an item
   * can be restored was false.
   *
   * @returns {object[]} plaintext fields plus id and the deletion time
   */
  listDeleted() {
    const out = [];
    for (const record of this.#items.values()) {
      if (!record.deletedAt) continue;
      const itemKey = unwrapKey(this.#vaultKey, record.wrappedKey);
      let payload;
      try {
        payload = open(itemKey, record, {
          vaultId: this.#meta.id,
          itemId: record.id,
          version: record.version,
        });
      } catch {
        // A record that will not open is not a deleted item anyone can restore, so it
        // is left out rather than shown as a row that fails when clicked.
        continue;
      }
      out.push({ ...payload, id: record.id, deletedAt: record.deletedAt });
    }
    return out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  /**
   * Decrypt one item.
   * @param {string} id
   * @returns {object|null} plaintext fields plus id, version and timestamps
   */
  readItem(id) {
    const record = this.#items.get(id);
    if (!record || record.deletedAt) return null;
    const itemKey = unwrapKey(this.#vaultKey, record.wrappedKey);
    const payload = open(itemKey, record, {
      vaultId: this.#meta.id,
      itemId: id,
      version: record.version,
    });
    return {
      ...payload,
      id,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Decrypted items, newest use first.
   * @param {{type?: string, env?: string, brand?: string}} [filter]
   */
  listFiltered(filter = {}) {
    const out = [];
    for (const record of this.#items.values()) {
      if (record.deletedAt) continue;
      const item = this.readItem(record.id);
      if (!item) continue;
      if (filter.type && item.type !== filter.type) continue;
      if (filter.env !== undefined && filter.env !== "" && item.env !== filter.env) continue;
      if (filter.brand && item.brand !== filter.brand) continue;
      out.push(item);
    }
    return out.sort((a, b) => {
      const x = a.lastUsedAt || "";
      const y = b.lastUsedAt || "";
      if (x === y) return a.name.localeCompare(b.name);
      return y.localeCompare(x);
    });
  }

  /**
   * Search without decrypting. Every query token must be present in an item's
   * blind index, so this reads like an AND filter. Returns ids.
   * @param {string} query
   * @returns {Set<string>} item ids
   */
  searchIds(query) {
    const wanted = blindQuery(this.#vaultKey, query);
    const hits = new Set();
    if (wanted.length === 0) return hits;
    for (const record of this.#items.values()) {
      if (record.deletedAt) continue;
      const set = new Set(record.searchTokens);
      if (wanted.every((t) => set.has(t))) hits.add(record.id);
    }
    return hits;
  }

  /**
   * The subset of items a query matches, decrypted.
   * @param {string} query
   * @param {object} [filter]
   */
  search(query, filter = {}) {
    const ids = this.searchIds(query);
    return this.listFiltered(filter).filter((i) => ids.has(i.id));
  }

  /**
   * Decrypt a record that is not the one this vault holds.
   *
   * Used to show the other side of a conflict before anyone decides. It runs the same
   * checks as `applyRemote`: the record has to unwrap under this vault key and open
   * with this vault id, so a record that is not genuine throws rather than decrypting
   * into a plausible looking lie.
   *
   * @param {object} record a record as it came over the wire
   * @returns {object} plaintext fields, plus id, revision and timestamps
   */
  readRemote(record) {
    if (!record || typeof record !== "object") throw new Error("a record is required");
    if (!record.id || !record.ciphertext || !record.nonce || !record.wrappedKey) {
      throw new Error("a record is missing its ciphertext");
    }
    const itemKey = unwrapKey(this.#vaultKey, record.wrappedKey);
    const payload = open(itemKey, record, {
      vaultId: this.#meta.id,
      itemId: record.id,
      version: record.version,
    });
    return {
      ...payload,
      id: record.id,
      rev: record.rev,
      deletedAt: record.deletedAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Take a record as it stands, without any of the checks `applyRemote` makes.
   *
   * Only for a caller that has already decided which side wins, and only after the
   * record has been through `readRemote`. It still cannot smuggle anything in: the
   * bytes are stored as given, and every later read has to open them under this
   * vault's key or fail.
   *
   * The revision is raised above both sides so the result is newer than either, and
   * it takes the next slot in the vault sequence so it syncs out on the next round.
   *
   * @param {object} record
   * @param {{over?: number}} [opts] a revision to beat
   */
  adoptRemote(record, { over = 0 } = {}) {
    if (!record || !record.id || !record.ciphertext) throw new Error("a record is required");
    // Prove it first. Decryption here is the only thing that makes the bytes safe to
    // store, so it happens before the write rather than after.
    this.readRemote(record);
    // Strictly above every side, not merely equal to the highest. An adopted copy at
    // the same revision as the one it replaces is refused by the store, so the
    // conflict would look resolved here and stay unresolved everywhere else.
    const rev = Math.max(record.rev || 1, over, this.#items.get(record.id)?.rev || 0) + 1;
    this.#items.set(record.id, {
      id: record.id,
      type: record.type,
      rev,
      seq: this.#nextSeq(),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt ?? null,
      wrappedKey: record.wrappedKey,
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      searchTokens: Array.isArray(record.searchTokens) ? record.searchTokens : [],
    });
    return rev;
  }

  /** Record that an item was used. Best effort; never blocks a copy. */
  touch(id) {
    const record = this.#items.get(id);
    if (!record) return;
    const item = this.readItem(id);
    if (!item) return;
    this.updateItem(id, { ...item, lastUsedAt: new Date().toISOString() });
  }

  /**
   * What can be written to disk. Ciphertext and non-secret metadata only.
   * The blind index is included; it leaks token equality, which the plan
   * documents as a deliberate tradeoff.
   */
  serialize() {
    return {
      meta: this.#meta,
      items: Object.fromEntries(this.#items),
    };
  }

  /** Drop key material. */
  lock() {
    this.#vaultKey.fill(0);
    this.#items.clear();
  }

  /** Test and audit helper: the stored record for an id. */
  rawRecord(id) {
    return this.#items.get(id) || null;
  }

  /** Test only: expose the vault key so tests can check the second layer of
   *  binding without going through item unwrapping. Never used by the server. */
  vaultKeyForTest() {
    return this.#vaultKey;
  }

  /**
   * The vault key, for handing to a session store. Named so a reader notices it:
   * this is the one call that takes the key out of the vault object.
   */
  vaultKeyForSession() {
    return this.#vaultKey;
  }

  /** Every stored record, for assertions about what is on disk. */
  rawRecords() {
    return [...this.#items.values()];
  }
}

/**
 * Normalise and validate item fields. Rejects anything that would put an
 * unexpected shape into the ciphertext.
 */
export function cleanItem(input = {}) {
  const type = input.type || "api-key";
  if (!TYPES.includes(type)) throw new Error(`unknown item type: ${type}`);
  const env = input.env === undefined ? "" : String(input.env);
  if (!ENVIRONMENTS.includes(env)) throw new Error(`unknown environment: ${env}`);
  const str = (v, max = 4000) => (v === undefined || v === null ? "" : String(v).slice(0, max));
  const item = {
    name: str(input.name, 200).trim() || "Untitled item",
    brand: str(input.brand, 60).trim(),
    service: str(input.service, 200).trim(),
    host: str(input.host, 200).trim(),
    type,
    env,
    value: str(input.value, 8000),
    notes: str(input.notes, 8000),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 12).map((t) => str(t, 40).trim()).filter(Boolean) : [],
    lastUsedAt: input.lastUsedAt ? str(input.lastUsedAt, 40) : null,
    createdAt: input.createdAt ? str(input.createdAt, 40) : new Date().toISOString(),
    copyCount: Number.isFinite(input.copyCount) ? input.copyCount : 0,
  };
  if (type === "totp") {
    const t = input.totp || {};
    if (!t.secret) throw new Error("a one-time code item needs a secret");
    item.totp = {
      secret: String(t.secret).toUpperCase().replace(/[\s=]+/g, ""),
      issuer: str(t.issuer, 120),
      account: str(t.account, 200),
      digits: Number(t.digits) === 8 ? 8 : 6,
      step: Number(t.step) > 0 ? Math.min(120, Math.max(10, Number(t.step))) : 30,
    };
  }
  if (type === "backup-codes") {
    item.codes = Array.isArray(input.codes)
      ? input.codes.slice(0, 100).map((c) => ({
          code: str(typeof c === "string" ? c : c.code, 60).toUpperCase(),
          usedAt: c && c.usedAt ? str(c.usedAt, 40) : null,
        }))
      : [];
  }
  return item;
}
