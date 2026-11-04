// The .env reader, which exists so a secret key has somewhere to live that is not
// a commit. Its failure mode matters: if it silently overrides the real
// environment, a deployment's own configuration loses to a stray file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parse, load } from "../src/core/env.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parse", () => {
  test("reads assignments", () => {
    const v = parse("A=1\nB=two\n");
    assert.deepEqual(v, { A: "1", B: "two" });
  });

  test("ignores comments and blank lines", () => {
    assert.deepEqual(parse("# note\n\nA=1\n   \n# another\nB=2"), { A: "1", B: "2" });
  });

  test("strips surrounding quotes but keeps inner spaces", () => {
    const v = parse('A="hello world"\nB=\'single\'\nC= bare \n');
    assert.equal(v.A, "hello world");
    assert.equal(v.B, "single");
    assert.equal(v.C, "bare");
  });

  test("keeps equals signs in the value", () => {
    // A base64 secret ends in =, and truncating it would produce a broken key that
    // looks configured.
    assert.equal(parse("KEY=abc==").KEY, "abc==");
    assert.equal(parse("URL=postgres://u:p@h/db?x=1").URL, "postgres://u:p@h/db?x=1");
  });

  test("accepts the export prefix", () => {
    assert.deepEqual(parse("export A=1"), { A: "1" });
  });

  test("ignores lines that are not assignments", () => {
    assert.deepEqual(parse("not an assignment\n=novalue\n1BAD=x\nA=1"), { A: "1" });
  });
});

describe("load", () => {
  test("does not override the real environment", () => {
    // This is the important one. A deployment sets LOGO_DEV_KEY for real; a stale
    // .env in the checkout must not win.
    const dir = mkdtempSync(join(tmpdir(), "hasp-env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "A=fromfile\nB=fromfile\n");
    const env = { A: "fromshell" };
    const applied = load(file, env);
    assert.equal(env.A, "fromshell", "the file overrode the environment");
    assert.equal(env.B, "fromfile");
    assert.deepEqual(applied, ["B"], "the report should list only what it set");
  });

  test("an empty value counts as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "hasp-env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "A=fromfile\n");
    const env = { A: "" };
    load(file, env);
    assert.equal(env.A, "fromfile");
  });

  test("a missing file is not an error", () => {
    const env = {};
    assert.deepEqual(load("/no/such/file/.env", env), []);
    assert.deepEqual(env, {});
  });
});
