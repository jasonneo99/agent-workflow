import assert from "node:assert/strict";
import test from "node:test";
import { buildRunPresentation, storedRunPresentation } from "./run-presentation.js";

test("creates a clear workflow and project headline for vague human input", () => {
  assert.deepEqual(buildRunPresentation({ task: "fix it", workflowId: "debug-failure", projectName: "Example App" }), {
    title: "Debug Failure for Example App",
    description: "Complete the debug failure workflow for Example App. Original request: “fix it”.",
    version: 1
  });
});

test("preserves substantive request meaning while bounding card text", () => {
  const result = buildRunPresentation({
    task: "  Please repair the queue lease renewal bug. Keep immutable history and add regression coverage.  ",
    workflowId: "build-feature",
    projectName: "Agent Workflow"
  });
  assert.equal(result.title, "Build Feature: Please repair the queue lease renewal bug");
  assert.equal(result.description, "For Agent Workflow: Please repair the queue lease renewal bug. Keep immutable history and add regression coverage.");
});

test("keeps orchestration boilerplate out of the human-facing card", () => {
  const result = buildRunPresentation({
    task: `GUARDRAIL: Local project edits, allowlisted commands, checkpoints, and verification are allowed. Network access, publishing, secrets, destructive actions, and authority expansion require explicit approval.

Continue this durable Agent Workflow conversation. Inspect current project evidence before making factual claims. Return a concise user-facing answer, not raw orchestration logs.

Selected context:
[file: private-runtime.json]`,
    workflowId: "dynamic-feature-delivery-7aa47b3d0816",
    projectName: "jarvis"
  });
  assert.equal(result.title, "Dynamic Feature Delivery 7aa47b3d0816 for jarvis");
  assert.equal(
    result.description,
    "Continue the current requested work for jarvis through the dynamic feature delivery 7aa47b3d0816 workflow. Open “Original request” for the exact submitted context."
  );
});

test("reads only valid stored presentation metadata", () => {
  const valid = { presentation: { title: "Readable title", description: "Readable description", version: 1 } };
  assert.deepEqual(storedRunPresentation(valid), valid.presentation);
  assert.equal(storedRunPresentation({ presentation: { title: "", description: "bad", version: 1 } }), null);
});
