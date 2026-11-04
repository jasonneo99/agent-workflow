import assert from "node:assert/strict";
import test from "node:test";
import { rejectedPatchFeedback, replaceRefreshedPatchRead, retainPendingPatchBatch } from "./file-mutation-retry.js";
import { foldStateDeltas, renderFactSet } from "../../model-providers/src/state-deltas.js";

test("retry feedback preserves the rejected edit and exact count failure", () => {
  const patch = "@@ -1,1 +1,3 @@\n-old\n+new\n+next\n";
  const feedback = rejectedPatchFeedback("hunk count mismatch; expected -1/+3, received -1/+2", patch);
  assert.ok(feedback.includes(patch));
  assert.match(feedback, /expected -1\/\+3, received -1\/\+2/u);
  assert.match(feedback, /not applied/u);
  const rendered = renderFactSet(foldStateDeltas([{ op: "update", key: "file:src/a.ts", fact: feedback,
    provenance: { stageId: "implement", agentId: "implementation-agent", actionType: "file_write" }, assertedAt: "2026-01-01T00:00:00Z" }]));
  assert.ok(rendered.includes(patch));
});

test("large rejected patches are explicitly bounded without losing the failure", () => {
  const feedback = rejectedPatchFeedback("hunk count mismatch", "+line\n".repeat(1000));
  assert.match(feedback, /hunk count mismatch/u);
  assert.match(feedback, /truncated; do not treat as a complete patch/u);
  assert.ok(feedback.length < 3200);
});

test("retry refresh removes stale full and ranged reads but preserves other files", () => {
  const reads = [
    { path: "src/a.ts", content: "old", truncated: false },
    { path: "src/a.ts#L10-L20", content: "old slice", truncated: false },
    { path: "src/ab.ts", content: "other", truncated: false }
  ];
  replaceRefreshedPatchRead(reads, { path: "src/a.ts", content: "current", truncated: false, sha256: "fresh" });
  assert.deepEqual(reads.map(read => read.path), ["src/ab.ts", "src/a.ts"]);
  assert.equal(reads[1].content, "current");
});

test("only a local one-mutation correction retains an unvisited batch", () => {
  const write = { path: "src/first.ts", content: "corrected" };
  const pending = [{ path: "src/second.ts", content: "next" }];
  const correction = { outcome: "completed" as const, summary: "Synthetic correction", artifact: { findings: [] },
    requestedFileWrites: [write], requestedCommands: ["node check.cjs"] };
  const rejectedPlans = [
    { ...correction, outcome: "blocked" as const },
    { ...correction, requestedFileWrites: [] },
    { ...correction, requestedFileWrites: [pending[0]!] },
    { ...correction, requestedFileWrites: [write, pending[0]!] }
  ];
  for (const next of rejectedPlans) assert.equal(retainPendingPatchBatch({ rejectedPath: write.path,
    pendingWrites: pending, deferredCommands: ["node original.cjs"], correction: next }), next,
  "Blocked, superseded and broader plans must not acquire abandoned mutations or commands");
  const merged = retainPendingPatchBatch({ rejectedPath: write.path, pendingWrites: pending,
    deferredCommands: ["node original.cjs", "node check.cjs"], correction });
  assert.deepEqual(merged.requestedFileWrites, [write, ...pending]);
  assert.deepEqual(merged.requestedCommands, ["node original.cjs", "node check.cjs"]);
  assert.deepEqual(correction.requestedFileWrites, [write]); assert.deepEqual(pending, [{ path: "src/second.ts", content: "next" }]);
});
