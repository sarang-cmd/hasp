# Security

Hasp holds credentials, so the honest version of this document leads with what it
is: **a tested sample, not an audited product.** Read [Guarantees](#what-is-guaranteed)
and [Non-goals](#what-is-not-guaranteed) before putting anything real in it.

## Reporting

Open a [private security advisory](https://github.com/sarang-cmd/hasp/security/advisories/new).
Do not open a public issue for anything that could be used against a running
instance. Expect a reply within a week; this is a small project and that is the
honest timeframe.

If you are reporting a leaked credential rather than a vulnerability, rotate it
first. Nothing in this repository should ever contain a real one; if it does, that
is itself the bug.

## What is guaranteed

These are enforced by code and pinned by tests. Each line names the test file that
would fail if the guarantee were removed.

### The master password is never stored
The password derives a key with scrypt, and that key unwraps a randomly generated
vault key. Only the wrapped key is written to disk. The password itself is not
persisted, hashed, or logged. — `test/core.test.mjs`

### Item ciphertext is bound to its position
Every item is sealed with associated data covering the vault id, the item id and
the item version. A ciphertext moved to another row, or rolled back to an older
version, fails to open rather than opening as something else. — `test/core.test.mjs`

### A wrong password cannot be told from a corrupt vault
Both fail at the unwrap with the same error, so the response does not distinguish
"you typed it wrong" from "this file is damaged". — `test/core.test.mjs`

### Nothing is written to disk in plaintext
The vault file is checked after every write for the sample values it should contain
only in encrypted form. — `test/core.test.mjs`

### Guessing is bounded
Three free attempts, then a doubling wait from two seconds to a two minute ceiling,
measured per client address and cleared on success. A correct password is refused
while a wait is running, so the throttle cannot be used as an oracle. — `test/throttle.test.mjs`

### The browser is constrained
Sessions are `HttpOnly; SameSite=Strict; Path=/`. Cross-origin POSTs are refused.
CSP is `default-src 'self'` with `nosniff`, `DENY` and `no-referrer`. Path
traversal is refused including encoded forms. — `test/api.test.mjs`

### The vault key lives only in memory
It is held in the process, dropped on lock, on idle timeout and on shutdown. It is
never serialised. — `src/core/session.js`

## What is not guaranteed

Say these out loud before trusting the product with a real key.

- **No independent review.** The cryptography has not been audited by anyone but
  its author and its tests. Tests find the bugs you thought to test for.
- **The cipher is not the one the plan specified.** It is `chacha20-poly1305` with
  a 12-byte nonce, not XChaCha20-Poly1305. `src/core/crypto.js` says so at the top.
  The practical consequence: with a 12-byte random nonce, nonce reuse becomes
  plausible only at astronomically large item counts, but the margin is smaller
  than the plan promised and it is stated rather than papered over.
- **The throttle is process-local and in memory.** Restarting the server clears
  every record; several instances behind a load balancer would each keep their own
  count. That is right for a single local vault and wrong for a hosted one.
- **No transport security is provided by this project.** Served over plain HTTP, a
  password crosses the wire in the clear. Put it behind TLS or bind it to loopback.
- **No protection against a compromised host.** If something can read the process
  memory, it can read the vault key. Local-first means the machine is the boundary.
- **No key rotation.** Rotating the master password is not implemented.
- **Passkey unlock is a stub.** It renders and stores nothing.

## Threat model

**In scope.** Someone with the vault file but not the password. Someone sending
requests to a running instance. Someone who has stolen a device that was left
unlocked (the idle lock is the mitigation, and it is a speed bump, not a wall).

**Out of scope.** Malware on the machine, a compromised browser, a keylogger, and
the operator. Those are not solvable by a local web app and pretending otherwise
would be the dishonest part of a security document.

## If you find your own key in this repository

That should be impossible: every sample value is worded as an example, and the
parser tests build their inputs from the shape table rather than pasting keys. If
one is there anyway, treat the key as compromised, rotate it, and open an advisory.
