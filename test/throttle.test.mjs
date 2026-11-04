// The throttle is the only thing bounding password guesses, so its arithmetic is
// worth pinning: an off-by-one here is the difference between "three free
// attempts" and "three free attempts then wait", and a bad cap turns a locked-out
// attacker into a permanently locked-out user.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  retryAfter,
  recordFailure,
  recordSuccess,
  inspect,
  reset,
  FREE_ATTEMPTS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  FORGET_AFTER_MS,
} from "../src/core/throttle.js";

const K = "127.0.0.1";

describe("throttle", () => {
  beforeEach(() => reset());

  test("an unseen key waits for nothing", () => {
    assert.equal(retryAfter(K), 0);
    assert.equal(inspect(K), null);
  });

  test("the first failures are free", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      assert.equal(recordFailure(K), 0, `failure ${i + 1} should not delay`);
      assert.equal(retryAfter(K), 0);
    }
    assert.equal(inspect(K).failures, FREE_ATTEMPTS);
  });

  test("the next failure costs a wait, and it is measured from the last try", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(K);
    const now = 1_000_000;
    const delay = recordFailure(K, now);
    assert.equal(delay, BASE_DELAY_MS);
    // Immediately afterwards the wait is still almost the whole base delay.
    assert.equal(retryAfter(K, now), BASE_DELAY_MS);
    assert.equal(retryAfter(K, now + BASE_DELAY_MS), 0, "the wait has expired");
  });

  test("each further failure doubles the wait", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(K);
    const now = 1_000_000;
    const first = recordFailure(K, now);
    const second = recordFailure(K, now);
    const third = recordFailure(K, now);
    assert.equal(first, BASE_DELAY_MS);
    assert.equal(second, BASE_DELAY_MS * 2);
    assert.equal(third, BASE_DELAY_MS * 4);
  });

  test("the wait is capped, so a locked-out user is not locked out for good", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(K);
    const now = 1_000_000;
    let last = 0;
    for (let i = 0; i < 40; i++) last = recordFailure(K, now);
    assert.equal(last, MAX_DELAY_MS);
    // And it is a ceiling, not a runaway: still MAX after more.
    assert.equal(recordFailure(K, now), MAX_DELAY_MS);
  });

  test("a success clears the record", () => {
    for (let i = 0; i < 6; i++) recordFailure(K);
    assert.ok(retryAfter(K) > 0);
    recordSuccess(K);
    assert.equal(retryAfter(K), 0);
    assert.equal(inspect(K), null);
  });

  test("keys are independent", () => {
    for (let i = 0; i < 6; i++) recordFailure("10.0.0.1");
    assert.ok(retryAfter("10.0.0.1") > 0);
    assert.equal(retryAfter("10.0.0.2"), 0, "another client must not be punished");
  });

  test("a quiet record is eventually forgotten", () => {
    const now = 1_000_000;
    for (let i = 0; i < 6; i++) recordFailure(K, now);
    // Long after the window, a failure prunes the old record first, so the new
    // one starts from a clean count rather than inheriting a stale one.
    recordFailure(K, now + FORGET_AFTER_MS + 1);
    assert.equal(inspect(K).failures, 1);
  });

  test("a clock that jumps backwards does not extend the wait", () => {
    for (let i = 0; i < 6; i++) recordFailure(K, 1_000_000);
    // Asking with a time *before* the failure must give exactly the policy delay,
    // not that delay plus the size of the jump. A backwards clock should not earn
    // a free attempt either, so it is not zero: it is the full, correctly capped
    // delay, which is what the fix in retryAfter() guarantees.
    // Six failures is three past the free ones, so step = 2 and the delay is 4x base.
    assert.equal(retryAfter(K, 1), BASE_DELAY_MS * 4);
  });
});
