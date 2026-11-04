// Throttling for the one route that guards everything else.
//
// scrypt at N=65536 makes each guess expensive, but "expensive" is not "bounded".
// Without a throttle an attacker with a socket can present guesses as fast as the
// server will derive keys, forever, and the only thing standing between them and
// the vault is the password's own entropy. This bounds the rate.
//
// The policy is deliberately blunt:
//
//   - the first FREE_ATTEMPTS failures cost nothing, so a person who mistypes
//     twice is not punished
//   - after that each failure doubles the wait, capped at MAX_DELAY_MS
//   - a success clears the record for that key
//
// It is in memory and process-local. That is a real limitation and it is stated
// rather than hidden: restarting the server clears every record, and two servers
// behind a load balancer would each keep their own count. For a local-first vault
// that is the right trade (no durable record of failed logins to leak, no shared
// state to corrupt); for a hosted deployment it would need a shared store.

/** Failures before the throttle engages at all. */
export const FREE_ATTEMPTS = 3;

/** The first penalty, in milliseconds. It doubles from here. */
export const BASE_DELAY_MS = 2_000;

/** The ceiling. A locked-out attacker waits two minutes, not two days. */
export const MAX_DELAY_MS = 120_000;

/** How long an idle record is kept before it is forgotten entirely. */
export const FORGET_AFTER_MS = 60 * 60 * 1000;

/** key -> { failures, lastAt } */
const records = new Map();

/** Prune records that have been quiet long enough to be irrelevant. */
function prune(now) {
  for (const [key, rec] of records) {
    if (now - rec.lastAt > FORGET_AFTER_MS) records.delete(key);
  }
}

/** How long, in ms, this key must wait before its next attempt. 0 means now. */
export function retryAfter(key, now = Date.now()) {
  const rec = records.get(key);
  if (!rec) return 0;
  if (rec.failures <= FREE_ATTEMPTS) return 0;
  const step = rec.failures - FREE_ATTEMPTS - 1;
  const delay = Math.min(BASE_DELAY_MS * 2 ** step, MAX_DELAY_MS);
  // Clamp elapsed at zero. A recorded failure with a timestamp in the future can
  // only mean the clock moved backwards, and letting that negate the elapsed time
  // would *extend* the wait by the size of the jump: the wrong way round.
  const elapsed = Math.max(0, now - rec.lastAt);
  return Math.max(0, delay - elapsed);
}

/** Record a failure and return the delay that now applies. */
export function recordFailure(key, now = Date.now()) {
  prune(now);
  const rec = records.get(key) || { failures: 0, lastAt: now };
  rec.failures += 1;
  rec.lastAt = now;
  records.set(key, rec);
  return retryAfter(key, now);
}

/** Forget a key. Called on a successful unlock. */
export function recordSuccess(key) {
  records.delete(key);
}

/** The state of a key, for tests and for the API to report. */
export function inspect(key) {
  return records.has(key) ? { ...records.get(key) } : null;
}

/** Drop everything. Tests use this; so does shutdown. */
export function reset() {
  records.clear();
}
