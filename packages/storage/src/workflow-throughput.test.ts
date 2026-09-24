import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowThroughputRows } from "./workflow-throughput.js";

test("workflow throughput rows normalize database counts", () => {
  assert.deepEqual(normalizeWorkflowThroughputRows([
    { key: "2026-09-23", completed: "9", failed: "8", active: "12" },
    { key: "2026-09-24", completed: "0", failed: "0", active: "0" }
  ]), [
    { key: "2026-09-23", completed: 9, failed: 8, active: 12 },
    { key: "2026-09-24", completed: 0, failed: 0, active: 0 }
  ]);
});
