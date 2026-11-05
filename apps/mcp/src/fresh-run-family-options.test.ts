import assert from "node:assert/strict";
import test from "node:test";
import { appendFreshRunFamilyArgs, freshRunFamilyToolSchema } from "./fresh-run-family-options.js";

test("explicit fresh family relation is passed as literal CLI arguments", () => {
  const id = "ABCD1234-1234-4234-8234-123456789ABC";
  const args = ["run-and-watch", "build-feature", "--project", "fixture"];
  const reason = "  New baseline; keep $(printf unsafe) as ordinary reason text.  ";
  appendFreshRunFamilyArgs(args, {relatedRunId: id, relatedRunReason: reason});
  assert.deepEqual(args, ["run-and-watch", "build-feature", "--project", "fixture", "--related-to", id.toLowerCase(), "--related-reason", reason.trim()]);
  assert.ok(!args.some(arg => ["--source-run", "--replay", "--parent-run"].includes(arg)));
});

test("unrelated requests retain their independent CLI admission", () => {
  const args = ["run", "review-pr"];
  appendFreshRunFamilyArgs(args, {});
  assert.deepEqual(args, ["run", "review-pr"]);
  assert.equal(freshRunFamilyToolSchema.relatedRunId.parse(undefined), undefined);
});

for (const input of [
  {relatedRunId: "abcd1234-1234-4234-8234-123456789abc"},
  {relatedRunReason: "same task"},
  {relatedRunId: "similar-title", relatedRunReason: "same task"},
  {relatedRunId: "abcd1234-1234-4234-8234-123456789abc", relatedRunReason: "  "},
  {relatedRunId: "abcd1234-1234-4234-8234-123456789abc", relatedRunReason: "x".repeat(2001)}
]) test("invalid or incomplete family relation is rejected before forwarding: " + JSON.stringify(input).slice(0, 100), () => {
  const args = ["run", "build-feature"];
  assert.throws(() => appendFreshRunFamilyArgs(args, input));
  assert.deepEqual(args, ["run", "build-feature"]);
});
