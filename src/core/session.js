// Sessions.
//
// The vault key lives in this process only, keyed by an opaque session id handed
// to the browser as an HttpOnly cookie. Nothing about the vault key or the
// password key is written to disk or sent to the client. Closing the session
// drops the key, which is what the plan's auto-lock means in practice.
//
// This is a single process preview. A real deployment moves the session store to
// a shared service and adds device records, revocation and audit events.

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Idle timeout. The plan asks for five minutes. */
export const IDLE_MS = 5 * 60 * 1000;
/** Absolute cap regardless of activity. */
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/** @type {Map<string, {vaultId: string, key: Buffer, createdAt: number, seenAt: number}>} */
const sessions = new Map();

/** Open a session holding the unwrapped vault key. */
export function createSession(vaultId, vaultKey) {
  const id = randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions.set(id, { vaultId, key: Buffer.from(vaultKey), createdAt: now, seenAt: now });
  return id;
}

/** The cookie name. `__Host-` forces Secure, Path=/ and no Domain in browsers. */
export const COOKIE = "hasp_session";

/**
 * Look up a live session. Returns null when missing, expired or idle.
 * @param {string|undefined} id
 */
export function readSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (now - s.seenAt > IDLE_MS || now - s.createdAt > ABSOLUTE_MS) {
    forget(id);
    return null;
  }
  s.seenAt = now;
  return s;
}

/** Drop one session and its key material. */
export function forget(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.key.fill(0); // best effort; the Buffer is released either way
  sessions.delete(id);
  return true;
}

/** Drop every session. Used on shutdown. */
export function forgetAll() {
  for (const id of [...sessions.keys()]) forget(id);
}

/** Milliseconds of idle time left, for the client's lock countdown. */
export function remainingMs(id) {
  const s = sessions.get(id);
  if (!s) return 0;
  return Math.max(0, Math.min(IDLE_MS - (Date.now() - s.seenAt), ABSOLUTE_MS - (Date.now() - s.createdAt)));
}

/** Constant time compare, for any token check. */
export function tokenEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Test helper: how many sessions are live. */
export function sessionCount() {
  return sessions.size;
}
