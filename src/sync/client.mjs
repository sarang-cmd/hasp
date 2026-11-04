// The client half of sync. Decides what to send, what to accept, and what to
// report when two machines changed the same item.
//
// Three rules, in order of importance:
//
// 1. The local vault is the only place a secret is ever decrypted. Everything
//    sent is a record that is already encrypted at rest.
// 2. A record is accepted only after applyRemote() has opened it with the vault
//    key. A server that invents records, swaps ids or edits bytes produces a
//    throw, not a row.
// 3. A conflict is shown, not resolved silently. PLAN.md calls for last write
//    wins with a visible conflict log. The store refuses a stale write, and this
//    file records both sides so the user can pick.

import { SyncStore, toBlob } from "./store.mjs";

/** A pull or push failure with the status kept, so callers can branch cleanly. */
export class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SyncError";
    this.status = status;
  }
}

/**
 * Sync one vault against one store.
 *
 * The store is passed in rather than constructed here, so a test can hand over a
 * plain object and a deployment can hand over a store backed by anything.
 */
export class SyncClient {
  #vault;
  #store;
  #vaultId;
  #token;
  #seq;
  #sent;

  /**
   * @param {object} opts
   * @param {import("../core/vault.js").Vault} opts.vault
   * @param {SyncStore} opts.store
   * @param {string} opts.vaultId
   * @param {string} opts.token
   * @param {number} [opts.seq] the highest vault sequence this device has applied
   * @param {Map<string, number>} [opts.sent] the revision this device last pushed, by id
   */
  constructor({ vault, store, vaultId, token, seq = 0, sent }) {
    if (!vault) throw new SyncError("a vault is required");
    if (!store) throw new SyncError("a store is required");
    this.#vault = vault;
    this.#store = store;
    this.#vaultId = vaultId;
    this.#token = token;
    this.#seq = seq;
    // What has been sent is a revision per record, not a vault wide number and not
    // a bare set of ids. The sequence says when a record changed, not whether the
    // store has it. A set of ids says it left once, but an edited copy has to leave
    // again. A revision per record answers both.
    this.#sent = sent instanceof Map ? sent : new Map();
  }

  /** Where this device is in the vault sequence. Store it beside the pairing. */
  get seq() {
    return this.#seq;
  }

  /** The revision last pushed, by record id. Store it beside the pairing. */
  get sent() {
    return this.#sent;
  }

  /**
   * Ask the store for everything newer than this device, and apply it.
   *
   * Each record is validated by the vault before it is kept. A record that fails
   * is counted and skipped rather than allowed to abort the whole pull, because
   * one bad blob should not block every other item.
   *
   * @returns {{applied: number, ignored: number, rejected: number, seq: number}}
   */
  pull() {
    let answer;
    try {
      answer = this.#store.pull(this.#vaultId, this.#token, this.#seq);
    } catch (err) {
      throw new SyncError(err.message, err.status ?? 0);
    }
    let applied = 0;
    let ignored = 0;
    let rejected = 0;
    for (const record of answer.records) {
      try {
        if (this.#vault.applyRemote(record) === "applied") applied += 1;
        else ignored += 1;
      } catch {
        // Wrong vault, doctored id, edited bytes. The record is not stored.
        rejected += 1;
        continue;
      }
      // It came from the store, so the store has it. Without this, every pull is
      // echoed by the next push and lands as a 409 at an equal revision, which
      // reads as a conflict between a device and itself.
      // What the store holds, not what was pushed. A record pulled at revision 2
      // means the store is at 2, so this device knows that anything it produces at 2
      // is the same revision the store already has. That is how a genuine clash, two
      // devices both producing revision 2 from revision 1, is told apart from a
      // repeat of something already sent.
      if (!(this.#sent.get(record.id) >= record.rev)) this.#sent.set(record.id, record.rev);
      if (record.seq > this.#seq) this.#seq = record.seq;
    }
    // Trust the store's own high water mark only when every record landed. If one
    // was rejected, the caller should see it again on the next pull rather than
    // have it silently skipped forever.
    if (rejected === 0 && answer.seq > this.#seq) this.#seq = answer.seq;
    return { applied, ignored, rejected, seq: this.#seq };
  }

  /**
   * Send every local record the store has not seen.
   *
   * The store holds a copy, so the local side has to know what it already sent.
   * That is a revision per record: `seq` says when a record changed, not whether
   * the store has it, and a record can be edited twice without ever leaving.
   * Nothing is decrypted on the way out.
   *
   * A 409 means the store has a newer revision of that record. That is a real
   * conflict, so it is collected and returned rather than retried or swallowed.
   *
   * @returns {{pushed: number, conflicts: Array<{id: string, local: number, remote: number}>}}
   */
  push() {
    const conflicts = [];
    let pushed = 0;
    const records = this.#vault.rawRecords().filter((r) => (r.rev || 1) > (this.#sent.get(r.id) ?? 0));
    for (const record of records) {
      let blob;
      try {
        blob = toBlob(record);
      } catch {
        // Not a complete record, so it cannot be synced. Skipping is honest: the
        // alternative is sending half a record and failing later on the other side.
        continue;
      }
      try {
        this.#store.push(this.#vaultId, this.#token, blob);
        this.#sent.set(blob.id, blob.rev);
        pushed += 1;
      } catch (err) {
        if (err.status === 409) {
          // The store has a different revision of this record. Both sides changed
          // it from the same base. Recorded, not retried and not overwritten: the
          // caller decides, because only the caller can see both plaintexts.
          conflicts.push({ id: blob.id, local: blob.rev, remote: err.current ?? 0 });
        } else {
          throw new SyncError(err.message, err.status ?? 0);
        }
      }
    }
    return { pushed, conflicts };
  }

  /** Pull, then push. Returns both halves so a caller can report one line. */
  round() {
    const pulled = this.pull();
    const pushed = this.push();
    return { pulled, pushed, seq: this.#seq };
  }
}

/**
 * What can be written to disk about a sync pairing.
 *
 * The token is a credential: anyone holding it can write ciphertext into the
 * vault. It is not a key, so a leak does not expose a secret, but it does allow a
 * denial of service and junk records. Stored in the same 0600 file as the vault.
 * @param {{vaultId: string, token: string, seq: number, url: string}} pairing
 */
export function pairingFor({ vaultId, token, seq, url }) {
  return { vaultId, token, seq, url, at: new Date().toISOString() };
}

export { SyncStore, toBlob };
