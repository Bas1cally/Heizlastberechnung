import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "../src/typesafe/env.js";

test("reads plain key=value lines", () => {
  assert.deepEqual(parseEnv("TYPESAFE_API_KEY=abc123\n"), {
    TYPESAFE_API_KEY: "abc123",
  });
});

test("ignores comments, blanks and an `export` prefix", () => {
  const parsed = parseEnv(
    ["# a comment", "", "   ", "export TYPESAFE_API_KEY=abc", "#KEY=nope"].join("\n"),
  );
  assert.deepEqual(parsed, { TYPESAFE_API_KEY: "abc" });
});

test("strips surrounding quotes", () => {
  assert.deepEqual(parseEnv(`A="one"\nB='two'\nC=three`), {
    A: "one",
    B: "two",
    C: "three",
  });
});

test("keeps an empty value and values containing '='", () => {
  assert.deepEqual(parseEnv("EMPTY=\nURL=https://x.test/?a=b"), {
    EMPTY: "",
    URL: "https://x.test/?a=b",
  });
});

test("survives Windows line endings", () => {
  assert.deepEqual(parseEnv("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
});

test("skips malformed lines instead of throwing", () => {
  assert.deepEqual(parseEnv("no equals sign\n=novalue\n1BAD=x\nGOOD=y"), {
    GOOD: "y",
  });
});
