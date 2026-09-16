import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("blocked queue items expose a governed repair action", () => {
  assert.match(source, /queueRunActionForm\(item\.runId, "resolve-blocker", "Resolve Blocker"\)/u);
  assert.match(source, /queueRunActionForm\(item\.runId, "repair-blocked", "Diagnose as New Run"\)/u);
  assert.match(source, /if \(action === "resolve-blocker"\)/u);
  assert.match(source, /Blocker resolved and workflow resumed/u);
  assert.match(source, /if \(action === "repair-blocked"\)/u);
  assert.match(source, /indexProjectForRun\(\{ projectDir, maxFiles: 180/u);
  assert.match(source, /workflowId: "debug-failure"/u);
  assert.match(source, /actionType: "blocked_run_repair_queued"/u);
});

test("blocked repair preserves governance and truthful terminal semantics", () => {
  assert.match(source, /preserve the original task boundaries/u);
  assert.match(source, /report blocked rather than completed if a real approval/u);
  assert.match(source, /registeredProjectRootUri: details\.run\.projectRootUri/u);
  assert.match(source, /includeExactSourceExcerpts: true/u);
});

test("learning daemon auto-heals only recent context-only blockers", () => {
  assert.match(source, /autoHealOneBlockedRun\(targetProjectDir, target\.mode\)/u);
  assert.match(source, /mode !== "apply-approved"/u);
  assert.match(source, /7 \* 24 \* 60 \* 60 \* 1000/u);
  assert.match(source, /approvals\.some\(isOpenApproval\)/u);
  assert.match(source, /missingExistingEvidence/u);
  assert.match(source, /evaluationMetadata\?\.source\) === "blocked-run-repair"/u);
  assert.match(source, /preferImplementationSources: true/u);
});

test("learning diagnostics exposes direct blocker resolution", () => {
  assert.match(source, /failedRunRows[\s\S]{0,800}resolve-blocker[\s\S]{0,200}Resolve Blocker/u);
  assert.match(source, /<h2>Recent Failed Runs<\/h2>/u);
  assert.match(source, /resume the same durable run without creating a repair chain/u);
});
