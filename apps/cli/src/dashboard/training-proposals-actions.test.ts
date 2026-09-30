import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("training proposal actions launch linked evaluations and advance only from generated evidence", () => {
  const actions = source.slice(source.indexOf("function renderTrainingProposalActions"), source.indexOf("function renderContextGatewayHtml"));
  assert.match(actions, /item\.status === "pending"[\s\S]+Approve evaluation/u);
  assert.match(actions, /item\.status === "approved"[\s\S]+Run evaluation/u);
  assert.match(actions, /evaluation\.status === "completed"[\s\S]+Accept evaluation result/u);
  assert.match(actions, /Evaluation in progress/u);
  assert.match(actions, /Retry evaluation/u);
  assert.match(actions, /item\.status === "evaluated"[\s\S]+not promotion eligible[\s\S]+Record promotion decision/u);
  assert.match(actions, /item\.status === "promoted"[\s\S]+No further inbox action is required/u);
  assert.doesNotMatch(actions.slice(actions.indexOf('item.status === "approved"'), actions.indexOf('item.status === "evaluated"')), /Approve evaluation/u);
});

test("repeated training proposal decisions report a no-op instead of pretending to change state", () => {
  assert.match(source, /current\?\.status === status[\s\S]+No state change was needed/u);
});

test("evaluated status requires a completed linked run and derives its note from artifacts", () => {
  assert.match(source, /status === "evaluated"[\s\S]+linked approved evaluation run is required/u);
  assert.match(source, /details\.run\?\.status !== "completed"/u);
  assert.match(source, /Accepted completed evaluation run/u);
});

test("promotion requires a PASS verdict and non-pass evidence stays reviewable", () => {
  assert.match(source, /trainingEvaluationVerdict\(summary\) !== "PASS"/u);
  assert.match(source, /Only a PASS evaluation is eligible for promotion/u);
  assert.match(source, /View evidence run/u);
});

test("training evaluation queueing seeds the exact workflow snapshot before creating the run", () => {
  assert.match(source, /resolveWorkflow\(await loadWorkflows\(rootDir\), "training-evaluation"\)/u);
  assert.match(source, /workflowOverride: trainingWorkflow/u);
});
