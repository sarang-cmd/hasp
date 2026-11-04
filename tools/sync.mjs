// The second machine.
//
// A vault lives in one file on one machine. Sync is how a second machine gets a
// copy without a server deciding anything: this command pulls the ciphertext the
// store holds, proves each record belongs to this vault, and writes the result
// beside the vault file it was given.
//
// It talks to the store over HTTP. Nothing here decrypts for the store, and
// nothing here trusts what comes back until the vault has opened it.
//
//   node tools/sync.mjs --vault ~/.hasp/vault.json --url http://192.168.1.20:3000 \
//     --vault-id <id> --token <token>
//
// Exit codes: 0 nothing to report, 1 a refusal or a conflict, 2 a bad invocation.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = new URL("..", import.meta.url);

/**
 * Parse the flags. Written by hand rather than with a library, because the server
 * has no dependencies and neither should the tool that talks to it.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    // Keys lose their dashes, so the rest of the file reads `args.vault` rather than
    // `args["--vault"]`. The lookup in `missing` uses the same names.
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * What this invocation is missing, as a list a user can act on.
 *
 * The password is not on this list. A vault opened from a script should read the
 * password from the environment rather than from a shell history, and a tool that
 * takes `--password` invites exactly the habit that leaks it.
 */
export function missing(args) {
  const need = [];
  if (!args.vault || args.vault === true) need.push("--vault, the path to this machine's vault.json");
  if (!args.url || args.url === true) need.push("--url, where the other machine is listening");
  if (!args.vaultId || args.vaultId === true) need.push("--vault-id, from the pairing");
  if (!args.token || args.token === true) need.push("--token, from the pairing");
  return need;
}

/** A URL with no trailing slash and no path suffix that could be doubled. */
export function baseUrl(raw) {
  const parsed = new URL(String(raw));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("the url must start with http:// or https://");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/**
 * Ask the store for everything after `since`.
 *
 * A non-2xx is turned into a sentence rather than a status number, because the
 * caller here is a person at a terminal.
 */
export async function pull(url, { vaultId, token, since = 0, fetch: doFetch = fetch }) {
  const res = await doFetch(`${url}/api/sync/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vaultId, token, since }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why =
      body.error === "bad token" ? "the token was refused, so it is wrong or has been rotated"
      : body.error === "no such vault" ? "the other machine does not know that vault id"
      : body.error || `the other machine answered ${res.status}`;
    throw new Error(why);
  }
  return body;
}

/** Read a vault file, or explain that there is not one. */
export async function readVaultFile(path) {
  if (!existsSync(path)) {
    return { error: `no vault at ${path}. Run the app once on this machine, or copy the file across by hand.` };
  }
  const text = await readFile(path, "utf8");
  try {
    return { stored: JSON.parse(text) };
  } catch {
    return { error: `${path} is not valid JSON. It has been left alone.` };
  }
}

/**
 * Apply a pull to a stored vault and write it back.
 *
 * The vault object is the only thing that can validate a record, so this opens the
 * real Vault with the real password and lets `applyRemote` decide. A rejected
 * record is counted and left out, not forced in.
 */
export async function apply({ stored, password, records, out, Vault }) {
  const vault = await Vault.unlock(stored, password);
  let applied = 0;
  let unchanged = 0;
  let rejected = 0;
  for (const record of records) {
    try {
      const result = vault.applyRemote(record);
      if (result === "applied") applied += 1;
      else unchanged += 1;
    } catch {
      rejected += 1;
    }
  }
  if (applied > 0) await writeFile(out, JSON.stringify(vault.serialize(), null, 2), { mode: 0o600 });
  return { applied, unchanged, rejected, seq: vault.seq, written: applied > 0 };
}

/** The command itself. Returns an exit code. */
export async function main(argv, { fetch: doFetch = fetch, password = process.env.HASP_PASSWORD, log = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log("node tools/sync.mjs --vault <file> --url <origin> --vault-id <id> --token <token>");
    log("Reads the master password from HASP_PASSWORD.");
    return 0;
  }
  const gaps = missing(args);
  if (gaps.length) {
    log("Missing:");
    for (const gap of gaps) log(`  ${gap}`);
    return 2;
  }
  if (!password) {
    log("Set HASP_PASSWORD. This tool does not take a password on the command line, because a");
    log("shell history is a file that outlives the command.");
    return 2;
  }

  const path = resolve(String(args.vault));
  const url = baseUrl(args.url);

  let stored;
  try {
    stored = (await readVaultFile(path)).stored;
  } catch (err) {
    log(err.message);
    return 2;
  }
  if (!stored) {
    log((await readVaultFile(path)).error);
    return 2;
  }

  const { Vault } = await import(pathToFileURL(new URL("src/core/vault.js", HERE).pathname).href);

  let answer;
  try {
    // The position to resume from is the vault's own sequence, so a machine that
    // has pulled once asks only for what came after.
    answer = await pull(url, {
      vaultId: String(args.vaultId),
      token: String(args.token),
      since: Number.isInteger(stored.meta?.seq) ? stored.meta.seq : 0,
      fetch: doFetch,
    });
  } catch (err) {
    log(err.message);
    return 1;
  }

  let result;
  try {
    result = await apply({ stored, password, records: answer.records || [], out: path, Vault });
  } catch (err) {
    // A wrong password surfaces here, from the same code path the app uses.
    log(err.message === "Wrong master password" ? "The password does not open that vault." : err.message);
    return 1;
  }

  if (result.rejected) {
    log(`${result.rejected} record${result.rejected === 1 ? "" : "s"} could not be opened and were left out.`);
    log("That means the other machine is on a different vault, or something edited the data in transit.");
  }
  if (result.applied) {
    log(`${result.applied} record${result.applied === 1 ? "" : "s"} applied, written to ${path}.`);
  } else if (!result.rejected) {
    log(`Nothing new. The vault is at sequence ${result.seq}.`);
  }
  // A rejected record is a refusal the caller has to see, so it exits non-zero even
  // though the rest of the pull landed.
  return result.rejected ? 1 : 0;
}

// Importing this file must not run it. `node -e "import('./tools/sync.mjs')"` has no
// script argument at all, and the guard below threw on that before it could be
// asked anything.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // `--experimental-strip-types` is not needed here, but the suite runs this file
  // both ways, so the entry point stays plain.
  process.exitCode = await main(process.argv.slice(2));
}
