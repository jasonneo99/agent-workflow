import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("provider-use accepts the first-class local provider", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /const supported = \["auto", "mock", "local", "byo"/u);
  assert.match(source, /Using the local OpenAI-compatible runtime/u);
});
