import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("learning receipt compaction reports both mutation and clean no-op outcomes", () => {
  assert.match(source, /const result = await compactLearningActionReceiptFiles\(projectDir\)/u);
  assert.match(source, /Compacted \$\{result\.removedReceipts\} duplicate daemon-owned receipt/u);
  assert.match(source, /Receipt health is already clean; no duplicate daemon-owned receipts were removed\./u);
});

test("clean receipt health is rendered as a non-actionable state", () => {
  assert.match(source, /Receipt health is already clean; there are no duplicate daemon-owned receipts to compact\./u);
  assert.match(source, /clean \? "Receipts already compact" : "Compact daemon-owned receipts"/u);
});
