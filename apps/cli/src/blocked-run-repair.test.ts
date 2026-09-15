import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("blocked queue items expose a governed repair action", () => {
  assert.match(source, /queueRunActionForm\(item\.runId, "repair-blocked", "Repair Blocker"\)/u);
  assert.match(source, /if \(action === "repair-blocked"\)/u);
  assert.match(source, /indexProjectForRun\(\{ projectDir, maxFiles: 180/u);
  assert.match(source, /workflowId: "debug-failure"/u);
  assert.match(source, /actionType: "blocked_run_repair_queued"/u);
});

test("blocked repair preserves governance and truthful terminal semantics", () => {
  assert.match(source, /preserve the original task boundaries/u);
  assert.match(source, /report blocked rather than completed if a real approval/u);
  assert.match(source, /registeredProjectRootUri: details\.run\.projectRootUri/u);
});
