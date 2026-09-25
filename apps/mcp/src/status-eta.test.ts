import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("MCP status exposes machine-readable ETA metadata for assistants", () => {
  assert.match(source, /including evidence-based ETA, confidence, and reason/u);
  assert.match(source, /Return machine-readable run and ETA metadata for voice and assistant clients/u);
  assert.match(source, /if \(json\) args\.push\("--json"\)/u);
});
