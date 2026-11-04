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

  /**
   * @param {object} meta stored metadata: id, name, kdf, salt, wrapped, nonce, createdAt
   * @param {Buffer} vaultKey
   * @param {Map<string, object>} items stored records, ciphertext only
   */
  constructor(meta, vaultKey, items = new Map()) {
    this.#meta = meta;
    this.#vaultKey = vaultKey;
    this.#items = items;
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
      version,
      updatedAt: new Date().toISOString(),
      wrappedKey,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      searchTokens: blindTokens(this.#vaultKey, payload),
      history: history.slice(-5),
    });
  }

  /** Soft delete. A deleted item keeps its record so the change can sync. */
  deleteItem(id) {
    const record = this.#items.get(id);
    if (!record) throw new Error("item not found");
    this.#items.set(id, { ...record, deletedAt: new Date().toISOString() });
  }

  /** Restore a soft deleted item. */
  restoreItem(id) {
    const record = this.#items.get(id);
    if (!record) throw new Error("item not found");
    this.#items.set(id, { ...record, deletedAt: null });
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
