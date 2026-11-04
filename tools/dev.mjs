// Hasp, dev runner.
//
// `npm run dev` used to be a bare
//
//   node --watch-path=src --watch-path=app server.mjs --port=3000
//
// and a clean checkout has no app/ directory: it exists only on an unmerged
// branch. Node treats a --watch-path that does not exist as fatal rather than as
// a path to wait for, so the dev script died with ENOENT before the server ever
// started:
//
//   Error: ENOENT: no such file or directory, watch '...\hasp\app'
//
// This runner asks the filesystem which watched paths are actually present and
// passes only those, so a tree with or without app/ both start. Nothing about
// the server changes; this only decides what restarts it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths, relative to the repository root, a change to which should restart the server. */
export const WATCHED = ["src", "server.mjs", "app"];

/**
 * The watched candidates that exist under `root`, in declared order.
 *
 * Side effect free, so test/dev.test.mjs can pin the rule the crash came from:
 * an absent candidate is skipped, never handed to node.
 */
export function present(root, candidates = WATCHED) {
  return candidates.filter((name) => existsSync(join(root, name)));
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  // Anything after the runner on the command line is meant for the server.
  const args = [
    ...present(root).map((name) => `--watch-path=${name}`),
    join(root, "server.mjs"),
    ...process.argv.slice(2),
  ];

  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  // Propagate the child's status, so a server that fails to start is not
  // reported as a clean exit by the wrapper.
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === "SIGINT" ? 130 : 143));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
