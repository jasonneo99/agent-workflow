import assert from "node:assert/strict";
import test from "node:test";
import type { StageExecutionInput, StageExecutionOutput } from "./types.js";
import { hasPinnedBuildIntent, PINNED_BUILD_CONTRACT, scoreStageOutput, unfulfilledCompletionReason } from "./quality.js";

const input = {
  stageId: "implement",
  agentId: "implementation-agent",
  projectConfig: { project: { name: "example" } }
} as StageExecutionInput;

test("implementation completion fails closed when the output says no implementation occurred", () => {
  const output = {
    outcome: "completed",
    summary: "Completed read-only inspection. Implementation remains incomplete; no files were changed.",
    artifact: { findings: ["The plan is present."], nextAction: "Implement the requested changes." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.match(unfulfilledCompletionReason(input, output) ?? "", /claimed completion/i);
  const quality = scoreStageOutput(input, output);
  assert.equal(quality.passed, false);
  assert.equal(quality.score, 0);
});

test("review stages may correctly report that they made no source changes", () => {
  const output = {
    outcome: "completed",
    summary: "Review completed with no source changes.",
    artifact: {}
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason({ ...input, stageId: "review", agentId: "security-reviewer" }, output), null);
});

test("implementation may report a read-only model stage when governed writes are requested", () => {
  const output = {
    outcome: "completed",
    summary: "Prepared the fix; no files were modified in the read-only model stage.",
    artifact: { findings: ["A bounded source edit is required."], nextAction: "Execute the governed write." },
    requestedCommands: [],
    requestedFileWrites: [{ path: "src/example.py", content: "fixed = True\n" }]
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason(input, output), null);
});

test("backend delivery cannot complete with read-only discovery instead of a requested product", () => {
  const output = {
    outcome: "completed",
    summary: "Completed bounded read-only discovery. Backend implementation remains blocked; no files changed.",
    artifact: { findings: ["The implementation is absent."], nextAction: "Route implementation elsewhere." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  const backendInput = { ...input, stageId: "backend", agentId: "backend-engineer", workflowTask: "Build and deliver a finished local API." };
  assert.match(unfulfilledCompletionReason(backendInput, output) ?? "", /governed product file write/i);
});

test("delivery implementation requires a governed product write even without an explicit disclaimer", () => {
  const output = {
    outcome: "completed",
    summary: "Implementation work is complete and ready for review.",
    artifact: { findings: ["Reviewed the intended implementation."], nextAction: "Verify it." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  const deliveryInput = { ...input, workflowTask: "Build a finished dashboard application." };
  assert.match(unfulfilledCompletionReason(deliveryInput, output) ?? "", /governed product file write/i);
});

test("delivery verification cannot complete while reporting that tests were not run", () => {
  const output = {
    outcome: "completed",
    summary: "Verification review completed, but no runtime tests were run.",
    artifact: { findings: ["Runtime remains unverified."], nextAction: "Run the tests." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  const verifyInput = {
    ...input,
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Build and deliver a finished service.",
    priorStageArtifacts: [{
      stageId: "implement",
      agentId: "implementation-agent",
      summary: "Created the service.",
      artifact: { requestedFileWrites: [{ path: "src/service.ts", content: "export {};\n" }] }
    }],
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
  };
  assert.match(unfulfilledCompletionReason(verifyInput, output) ?? "", /verification was not performed/i);
});

test("delivery finalizer cannot package an explicitly unimplemented product as complete", () => {
  const output = {
    outcome: "completed",
    summary: "Packaging is complete; feature delivery remains unsupported. This is a proposal rather than a releasable feature.",
    artifact: { findings: ["No product code exists."], nextAction: "Implement the product." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  const finalizerInput = {
    ...input,
    stageId: "package",
    agentId: "pr-preparer",
    workflowTask: "Implement and ship the finished application.",
    stagePattern: { type: "finalizer", requiresVerifier: false, promotionGate: "approval", stopConditions: [] }
  };
  assert.match(unfulfilledCompletionReason(finalizerInput, output) ?? "", /finished product was not delivered/i);
});

test("build is a standalone pinned delivery keyword", () => {
  assert.equal(hasPinnedBuildIntent("Build a finished fan module"), true);
  assert.equal(hasPinnedBuildIntent("Rebuildable package analysis"), false);
  assert.match(PINNED_BUILD_CONTRACT, /create, verify, package, and deliver/iu);
});

test("pinned build verifier rejects a persuasive completion claim without product-write evidence", () => {
  const verifyInput = {
    ...input,
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Build a finished fan module",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] },
    priorStageArtifacts: [{ stageId: "plan", agentId: "technical-architect", summary: "Detailed plan complete.", artifact: {} }]
  };
  const output = {
    outcome: "completed",
    summary: "Everything is complete and ready to deliver.",
    artifact: { findings: ["All requirements appear satisfied."], nextAction: "Package it." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.match(unfulfilledCompletionReason(verifyInput, output) ?? "", /Pinned BUILD contract violated.*no prior governed product file write/iu);
});

test("pinned build finalizer requires both creation and verification evidence", () => {
  const finalizerInput = {
    ...input,
    stageId: "package",
    agentId: "pr-preparer",
    workflowTask: "Build a finished fan module",
    stagePattern: { type: "finalizer", requiresVerifier: false, promotionGate: "approval", stopConditions: [] },
    priorStageArtifacts: [{
      stageId: "implement",
      agentId: "implementation-agent",
      summary: "Created the module.",
      artifact: { requestedFileWrites: [{ path: "src/fan.ts", content: "export {};\n" }] }
    }]
  };
  const output = {
    outcome: "completed",
    summary: "Packaged the finished module.",
    artifact: { findings: ["Package ready."], nextAction: "Install it." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.match(unfulfilledCompletionReason(finalizerInput, output) ?? "", /no completed verification evidence/iu);
});

test("review workflow finalizers are not misclassified as product delivery stages", () => {
  const reviewInput = {
    ...input,
    workflowId: "review-pr",
    stageId: "final-review",
    agentId: "pr-preparer",
    workflowTask: "Review implementation work and identify remaining risks.",
    stagePattern: { type: "finalizer", requiresVerifier: false, promotionGate: "approval", stopConditions: [] }
  };
  const output = {
    outcome: "completed",
    summary: "Review complete with ordered findings and verification gaps.",
    artifact: { findings: ["One gap remains."], nextAction: "Address the finding." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason(reviewInput, output), null);
});
