import assert from "node:assert/strict";
import test from "node:test";
import { applyDiffHunk, applyUnifiedDiff, buildUnifiedDiff, parseDiffHunks } from "./file-diff.js";

test("unified diffs round-trip through per-hunk application", () => {
  const original = ["line one", "line two", "line three", "line four", "line five", "line six", "line seven", "line eight", ""].join("\n");
  const proposed = ["line one", "line TWO", "line three", "line four", "line five", "line six", "line SEVEN", "line eight", ""].join("\n");
  const diff = buildUnifiedDiff("src/example.txt", original, proposed);
  assert.match(diff, /^--- a\/src\/example\.txt\n\+\+\+ b\/src\/example\.txt\n/u);
  assert.match(diff, /-line two\n\+line TWO/u);
  assert.match(diff, /-line seven\n\+line SEVEN/u);
  assert.equal(applyUnifiedDiff(original, diff), proposed);

  // Per-hunk application, in order, reaches the same result.
  const hunks = parseDiffHunks(diff);
  assert.ok(hunks.length >= 1);
  let content = original;
  for (const hunk of hunks) content = applyDiffHunk(content, hunk);
  assert.equal(content, proposed);
});

test("a new file diffs from /dev/null and applies cleanly", () => {
  const proposed = "export const x = 1;\n";
  const diff = buildUnifiedDiff("src/new.ts", "", proposed);
  assert.match(diff, /^--- \/dev\/null\n\+\+\+ b\/src\/new\.ts\n/u);
  assert.match(diff, /@@ -0,0 \+1,2 @@/u);
  assert.equal(applyUnifiedDiff("", diff), proposed);
});

test("identical content produces no diff", () => {
  assert.equal(buildUnifiedDiff("src/a.txt", "same\n", "same\n"), "");
});

test("a hunk that does not match the preimage is rejected", () => {
  const original = "alpha\nbeta\ngamma\n";
  const proposed = "alpha\nBETA\ngamma\n";
  const diff = buildUnifiedDiff("src/a.txt", original, proposed);
  const [hunk] = parseDiffHunks(diff);
  assert.throws(() => applyDiffHunk("alpha\nCHANGED\ngamma\n", hunk), /does not apply cleanly/);
  assert.throws(() => applyDiffHunk("alpha\nbeta\n", hunk), /does not apply cleanly/);
});

test("distant changes become separate hunks", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  const original = `${lines.join("\n")}\n`;
  const changed = [...lines];
  changed[1] = "CHANGED 2";
  changed[38] = "CHANGED 39";
  const proposed = `${changed.join("\n")}\n`;
  const diff = buildUnifiedDiff("src/big.txt", original, proposed);
  const hunks = parseDiffHunks(diff);
  assert.equal(hunks.length, 2);
  assert.equal(applyUnifiedDiff(original, diff), proposed);
});
