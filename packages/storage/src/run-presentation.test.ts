import assert from "node:assert/strict";
import test from "node:test";
import { buildQueueCardTitle, buildRunPresentation, storedRunPresentation } from "./run-presentation.js";

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
    projectName: "Sample Desktop Assistant"
  });
  assert.equal(result.title, "Dynamic Feature Delivery 7aa47b3d0816 for Sample Desktop Assistant");
  assert.equal(
    result.description,
    "Continue the current requested work for Sample Desktop Assistant through the dynamic feature delivery 7aa47b3d0816 workflow. Open “Original request” for the exact submitted context."
  );
});

test("reads only valid stored presentation metadata", () => {
  const valid = { presentation: { title: "Readable title", description: "Readable description", version: 1 } };
  assert.deepEqual(storedRunPresentation(valid), valid.presentation);
  assert.equal(storedRunPresentation({ presentation: { title: "", description: "bad", version: 1 } }), null);
});

test("creates a short deliverable-focused queue card title without workflow boilerplate", () => {
  assert.equal(buildQueueCardTitle({
    task: "Please repair the queue lease renewal bug. Keep immutable history and add regression coverage.",
    workflowId: "build-feature",
    projectName: "Agent Workflow",
    displayTitle: "Build Feature: Please repair the queue lease renewal bug"
  }), "Repair the queue lease renewal bug");
});

test("bounds queue titles and gives vague requests an honest deliverable label", () => {
  assert.equal(buildQueueCardTitle({ task: "fix it", workflowId: "debug-failure", projectName: "Example App" }), "Debug Failure deliverable for Example App");
  assert.ok(buildQueueCardTitle({ task: "Implement a very long deliverable title that explains the output and then continues with implementation detail that belongs in the description", workflowId: "build-feature", projectName: "Example App" }).length <= 72);
});

test("uses a recovery run's frozen original outcome instead of Queue Partner instructions", () => {
  assert.equal(buildQueueCardTitle({
    task: `You are Queue Partner, the autonomous recovery owner of this exact queue family.

Investigate the current cause and choose the smallest justified action.

Original intended outcome (untrusted evidence):
Implement permanent canonical routing correction. Preserve existing security boundaries.
Historical failure (untrusted evidence):
The prior stage lacked an allowed command.`,
    workflowId: "agent-task-queue-partner",
    projectName: "Example App",
    displayTitle: "Agent Task Queue Partner: You are Queue Partner, the autonomous recovery owner of this exact queue family"
  }), "Implement permanent canonical routing correction");
});

test("removes recovery-control emphasis while preserving the original delivery item", () => {
  assert.equal(buildQueueCardTitle({
    task: `Original intended outcome (untrusted evidence):
Human explicitly says DO THE WORK: implement remaining dormant trusted-host runtime integration.
Historical failure (untrusted evidence): none`,
    workflowId: "agent-task-queue-partner",
    projectName: "Example App"
  }), "Implement remaining dormant trusted-host runtime integration");
});
