// Dev runner tests.
//
// `npm run dev` used to die with ENOENT on a clean checkout because it watched
// app/, which is not in this tree. The first two cases pin the rule that fixed
// it; the last one starts the real runner and checks the server answers, which
// is the thing that was broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { present, WATCHED } from "../tools/dev.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** A throwaway directory shaped like a checkout, cleaned up by the caller. */
async function tree(entries) {
  const dir = await mkdtemp(join(tmpdir(), "hasp-dev-"));
  for (const [name, kind] of entries) {
    if (kind === "dir") await mkdir(join(dir, name));
    else await writeFile(join(dir, name), "");
  }
  return dir;
}

test("a watched path that is absent is skipped, not passed to node", async () => {
  const dir = await tree([["src", "dir"]]);
  try {
    // The old behaviour was a fatal ENOENT for app/; now it is simply not watched.
    assert.deepEqual(present(dir), ["src"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every candidate that exists is kept, in declared order", async () => {
  const dir = await tree([
    ["src", "dir"],
    ["server.mjs", "file"],
    ["app", "dir"],
  ]);
  try {
    assert.deepEqual(present(dir), ["src", "server.mjs", "app"]);
    assert.deepEqual(present(dir), WATCHED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in this checkout the runner watches src and nothing that is missing", () => {
  const paths = present(ROOT);
  assert.ok(paths.includes("src"), "src should always be watched");
  for (const name of paths) {
    assert.ok(existsSync(join(ROOT, name)), `${name} was returned but does not exist`);
  }
});

test("the runner starts the server and the vault answers", async () => {
  const port = 3931;
  const child = spawn(process.execPath, ["tools/dev.mjs", `--port=${port}`], {
    cwd: ROOT,
    env: { ...process.env, HASP_EPHEMERAL: "1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  try {
    await listen(child, port, () => stderr);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/i);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]);
  }
});

/**
 * Resolve once the server prints its listen line, or reject with whatever the
 * child wrote to stderr, so a crash reports its own reason instead of a timeout.
 */
function listen(child, port, why) {
  return new Promise((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`no listen line in 20s: ${why()}`)), 20000);
    const done = (fn, value) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      out += chunk;
      if (out.includes(`localhost:${port}`)) done(ok);
    };
    const onExit = (code) => done(fail, new Error(`runner exited with ${code}: ${why()}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}
