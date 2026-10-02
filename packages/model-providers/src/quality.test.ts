import assert from "node:assert/strict";
import test from "node:test";
import type { StageExecutionInput, StageExecutionOutput } from "./types.js";
import { completedStageProvidesPinnedBuildEvidence, hasPinnedBuildIntent, PINNED_BUILD_CONTRACT, scoreStageOutput, unfulfilledCompletionReason, verificationCompletionReason, workflowAcceptanceTask } from "./quality.js";

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

test("blocked lifecycle output cannot receive a perfect passing quality score", () => {
  const output = {
    outcome: "blocked",
    blockedReason: "A required external dependency is unavailable.",
    summary: "The stage produced detailed evidence but remains blocked by an unavailable external dependency.",
    artifact: { findings: ["The external service is unreachable."], nextAction: "Restore the dependency and retry." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  const quality = scoreStageOutput({ ...input, workflowId: "provider-smoke", workflowTask: "Verify the provider contract." }, output);
  assert.equal(quality.passed, false);
  assert.equal(quality.retryRecommended, true);
  assert.ok(quality.score <= 0.6);
  assert.match(quality.reasons.join(" "), /outcome is blocked/iu);
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
    requestedFileWrites: [{ path: "src/example.py", content: "fixed = True\n# Applied the bounded source edit requested by the planner.\n# Verified the change compiles and the targeted behavior now works.\n# This write is substantive and proves the implementation step executed.\n" }]
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason(input, output), null);
});

test("implementation receipts do not masquerade as product delivery", () => {
  const output = {
    outcome: "completed",
    summary: "Recorded the implementation blocker for the next agent.",
    artifact: { findings: ["The product is still absent."], nextAction: "Implement it." },
    requestedCommands: [],
    requestedFileWrites: [{ path: "docs/receipts/build-blocker.md", content: "Not implemented.\n" }]
  } as StageExecutionOutput;
  const deliveryInput = { ...input, workflowTask: "Build and deliver a finished application." };
  assert.match(unfulfilledCompletionReason(deliveryInput, output) ?? "", /governed product file write/iu);
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

test("advisory agent tasks may complete inspection without inventing a product write", () => {
  const output = {
    outcome: "completed",
    summary: "Inspected the implementation path and prepared bounded recommendations without changing files.",
    artifact: { findings: ["The existing implementation is valid."], nextAction: "Review the findings." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  const advisoryInput = {
    ...input,
    workflowId: "agent-task-implementation-agent",
    workflowTask: "Inspect the implementation and recommend any useful fixes."
  };
  assert.equal(unfulfilledCompletionReason(advisoryInput, output), null);
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

test("repair boilerplate does not turn a read-only original task into delivery work", () => {
  const workflowTask = [
    "Repair supervised Agent Workflow run source-run.",
    "Original workflow: provider-smoke.",
    "Original task: Perform a bounded read-only guarded-autonomy calibration smoke. Do not request commands or file writes.",
    "Supervisor finding: Invalid datetime at expires_at.",
    "Preserve the original acceptance contract. Otherwise implement missing product work and produce the package."
  ].join("\n\n");
  assert.equal(workflowAcceptanceTask(workflowTask), "Perform a bounded read-only guarded-autonomy calibration smoke. Do not request commands or file writes.");
  assert.equal(hasPinnedBuildIntent(workflowTask), false);
  const repairInput = { ...input, workflowId: "debug-failure", workflowTask, stageId: "fix", agentId: "implementation-agent" };
  const output = {
    outcome: "completed",
    summary: "Confirmed the existing fix and reproduced the read-only smoke successfully.",
    artifact: { findings: ["No additional product mutation is required."], nextAction: "Close the stale repair." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason(repairInput, output), null);
});

test("nested repairs retain the deepest original acceptance task", () => {
  const nested = [
    "Repair blocked Agent Workflow run repair-run.",
    "Original workflow: debug-failure.",
    "Original task: Repair supervised Agent Workflow run source-run.",
    "Original workflow: provider-smoke.",
    "Original task: Perform a bounded read-only smoke. Do not request file writes.",
    "Supervisor finding: Invalid datetime at expires_at.",
    "Recorded blocker: no blocker."
  ].join("\n\n");
  assert.equal(workflowAcceptanceTask(nested), "Perform a bounded read-only smoke. Do not request file writes.");
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

test("pinned build finalizer accepts durable product-write and executed verification receipts", () => {
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
      artifact: { actionResults: [{ type: "file_write", path: "src/fan.ts", artifactUri: "db://write/1" }] }
    }, {
      stageId: "verify",
      agentId: "auto-test-runner",
      summary: "The focused tests passed.",
      artifact: { actionResults: [{ commandLine: "npm test", exitCode: 0, timedOut: false, artifactUri: "db://command/1" }] }
    }]
  };
  const output = {
    outcome: "completed",
    summary: "Packaged the finished module.",
    artifact: { findings: ["Package ready."], nextAction: "Install it." },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason(finalizerInput, output), null);
});

test("verification prose cannot replace an executed verification receipt", () => {
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
    }, {
      stageId: "verify",
      agentId: "auto-test-runner",
      summary: "Everything looks verified.",
      artifact: { findings: ["No command receipt is attached."] }
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

test("verification commands execute before pending-result prose is judged incomplete", () => {
  const verifyInput = {
    ...input,
    workflowId: "build-feature",
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Implement and verify a consent-gated provider action.",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] },
    priorStageArtifacts: [{
      stageId: "implement",
      agentId: "implementation-agent",
      summary: "Implemented the feature.",
      artifact: { actionResults: [{ type: "file_write", path: "src/consent.ts", artifactUri: "db://write/consent" }] }
    }]
  };
  const output = {
    outcome: "completed",
    summary: "Requested focused tests through the governed executor; results are pending.",
    artifact: { findings: ["Verification commands are ready."], nextAction: "Run the requested commands." },
    requestedCommands: ["npm test"],
    requestedFileWrites: []
  } as StageExecutionOutput;

  assert.equal(unfulfilledCompletionReason(verifyInput, output), null);
});

test("checkpoint evidence rejects receipt-only implementation and accepts executed verification", () => {
  assert.equal(completedStageProvidesPinnedBuildEvidence({
    workflowTask: "Build a finished application",
    stageId: "implement",
    agentId: "implementation-agent",
    artifact: { actionResults: [{ type: "file_write", path: "docs/receipts/build.md" }] }
  }), false);
  assert.equal(completedStageProvidesPinnedBuildEvidence({
    workflowTask: "Build a finished application",
    stageId: "verify",
    agentId: "auto-test-runner",
    summary: "Focused tests passed.",
    artifact: { actionResults: [{ commandLine: "npm test", exitCode: 0, timedOut: false }] }
  }), true);
});

test("implementation accepts successful governed build and install command receipts", () => {
  const deliveryInput = { ...input, workflowId: "build-feature", workflowTask: "Build and deliver the iOS application." } as StageExecutionInput;
  const completed = (commandLine: string) => ({
    outcome: "completed",
    summary: "Built and delivered the requested application through the governed command executor.",
    artifact: { findings: ["The delivery command completed successfully."], nextAction: "Verify the installed application.", actionResults: [{ commandLine, exitCode: 0, timedOut: false }] },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput);

  assert.equal(unfulfilledCompletionReason(deliveryInput, completed("xcodebuild -scheme ExampleApp build")), null);
  assert.equal(unfulfilledCompletionReason(deliveryInput, completed("ios-deploy --bundle build/ExampleApp.app")), null);
  assert.equal(completedStageProvidesPinnedBuildEvidence({
    workflowTask: "Build and deliver the iOS application.",
    stageId: "implement",
    agentId: "implementation-agent",
    artifact: completed("xcodebuild -scheme ExampleApp archive").artifact
  }), true);
});

test("command-only delivery requests reach the governed executor before receipts exist", () => {
  const deliveryInput = { ...input, workflowId: "build-feature", workflowTask: "Build and deliver the iOS application." } as StageExecutionInput;
  const output = {
    outcome: "completed",
    summary: "Requested the authorized signed build and connected-device discovery.",
    artifact: { findings: ["Execution receipts are pending."], nextAction: "Run the governed commands." },
    requestedCommands: [
      "xcodebuild build -project apps/JarvisMobile/JarvisMobile.xcodeproj -scheme JarvisMobile -destination generic/platform=iOS",
      "xcrun devicectl list devices"
    ],
    requestedFileWrites: []
  } as StageExecutionOutput;

  assert.equal(unfulfilledCompletionReason(deliveryInput, output), null);
  assert.equal(scoreStageOutput(deliveryInput, output).passed, true);
});

test("unrelated command requests cannot bypass the delivery contract", () => {
  const deliveryInput = { ...input, workflowId: "build-feature", workflowTask: "Build and deliver the iOS application." } as StageExecutionInput;
  const output = {
    outcome: "completed",
    summary: "Requested inspection but did not create the application.",
    artifact: { findings: ["No product delivery exists."], nextAction: "Build the application." },
    requestedCommands: ["git status --short"],
    requestedFileWrites: []
  } as StageExecutionOutput;

  assert.match(unfulfilledCompletionReason(deliveryInput, output) ?? "", /successful delivery command receipt/iu);
});

test("implementation does not accept unrelated, failed, timed-out, or rejected commands as delivery evidence", () => {
  const deliveryInput = { ...input, workflowId: "build-feature", workflowTask: "Build and deliver the iOS application." } as StageExecutionInput;
  const output = (actionResult: Record<string, unknown>) => ({
    outcome: "completed",
    summary: "The command ran through the governed command executor but did not prove delivery.",
    artifact: { findings: ["No durable product delivery is proven."], nextAction: "Run a successful build.", actionResults: [actionResult] },
    requestedCommands: [],
    requestedFileWrites: []
  } as StageExecutionOutput);

  assert.match(unfulfilledCompletionReason(deliveryInput, output({ commandLine: "npm test", exitCode: 0, timedOut: false })) ?? "", /successful delivery command receipt/iu);
  assert.match(unfulfilledCompletionReason(deliveryInput, output({ commandLine: "xcodebuild -scheme ExampleApp build", exitCode: 65, timedOut: false })) ?? "", /successful delivery command receipt/iu);
  assert.match(unfulfilledCompletionReason(deliveryInput, output({ commandLine: "ios-deploy --bundle build/ExampleApp.app", exitCode: 0, timedOut: true })) ?? "", /successful delivery command receipt/iu);
  assert.match(unfulfilledCompletionReason(deliveryInput, output({ commandLine: "xcodebuild build", exitCode: 0, timedOut: false, type: "local_command_rejected" })) ?? "", /successful delivery command receipt/iu);
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

test("delivery verifiers require a successful governed command receipt", () => {
  const verifierInput = {
    ...input,
    workflowId: "debug-failure",
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Fix the failing reliability check",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
  } as StageExecutionInput;
  assert.match(verificationCompletionReason(verifierInput, [] as unknown[] ) ?? "", /successful governed verification command/iu);
  const failed = { commandLine: "npm run check", exitCode: 1, timedOut: false, artifactUri: "db://command/failed-check" };
  assert.match(verificationCompletionReason(verifierInput, [failed]) ?? "", /Verification command failed: npm run check \(exit code 1\).*db:\/\/command\/failed-check/iu);
  assert.match(verificationCompletionReason(verifierInput, [
    failed,
    { commandLine: "npm test", exitCode: 0, timedOut: false }
  ]) ?? "", /Verification command failed: npm run check/iu);
  assert.equal(verificationCompletionReason(verifierInput, [
    failed,
    { commandLine: "npm run check", exitCode: 0, timedOut: false }
  ]), null);
  assert.equal(verificationCompletionReason(verifierInput, [{ commandLine: "npm run check", exitCode: 0, timedOut: false }]), null);
});

test("delivery verification recognizes scoped npm and Node checks without accepting invalid receipts", () => {
  const verifierInput = {
    ...input, workflowId: "debug-failure", stageId: "verify", agentId: "auto-test-runner",
    workflowTask: "Fix the failing reliability check",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
  } as StageExecutionInput;
  for (const commandLine of ["npm run typecheck", "npm run validate-boundary", "npm exec -- node --import tsx --test packages/example.test.ts", "node --test example.test.js"]) {
    assert.equal(verificationCompletionReason(verifierInput, [{ commandLine, exitCode: 0 }]), null);
    for (const overrides of [{ exitCode: 1 }, { timedOut: true }, { type: "local_command_rejected" }]) {
      assert.notEqual(verificationCompletionReason(verifierInput, [{ commandLine, exitCode: 0, ...overrides }]), null);
    }
  }
  for (const commandLine of ["echo npm run typecheck", "npm run typecheck-other", "node --test-helper example.js"]) {
    assert.notEqual(verificationCompletionReason(verifierInput, [{ commandLine, exitCode: 0 }]), null);
  }
});

test("passing checks cannot hide an unresolved failing test suite", () => {
  const verifierInput = {
    ...input, workflowId: "debug-failure", stageId: "verify", agentId: "auto-test-runner",
    workflowTask: "Fix the failing reliability check",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
  } as StageExecutionInput;
  for (const commandLine of ["npm test", "npm exec -- node --import tsx --test --test-reporter=dot 'packages/**/*.test.ts'", "npm run typecheck"]) {
    const failed = { commandLine, exitCode: 1 };
    assert.match(verificationCompletionReason(verifierInput, [failed, { commandLine: "npm run validate-boundary", exitCode: 0 }]) ?? "", /Verification command failed/u);
    assert.equal(verificationCompletionReason(verifierInput, [failed, { commandLine, exitCode: 0 }]), null);
  }
});

test("final implementation gate consumes executed write receipts but rejects no-op and rejected writes", () => {
  const stage = { ...input, workflowId: "debug-failure", stageId: "fix", agentId: "implementation-agent", workflowTask: "Fix runtime continuation" } as StageExecutionInput;
  const write = { type: "file_write", path: "src/runtime.ts", artifactUri: "db://write/1", bytesWritten: 100, previousHash: "before", nextHash: "after" };
  const output = { outcome: "completed", summary: "Runtime changed", artifact: { actionResults: [write] }, requestedCommands: [], requestedFileWrites: [] } as StageExecutionOutput;
  assert.equal(unfulfilledCompletionReason(stage, output), null);
  for (const override of [{ type: "file_write_rejected" }, { nextHash: "before" }, { bytesWritten: 0 }, { path: ".agent-workflow/receipt.md" }]) {
    assert.notEqual(unfulfilledCompletionReason(stage, { ...output, artifact: { actionResults: [{ ...write, ...override }] } }), null);
  }
});

test("finish and repair wording cannot bypass failed delivery verification", () => {
  for (const workflowTask of ["Finish the source-size repair", "Repair the source-size ratchet", "Complete the delivery repair"]) {
    const verifierInput = {
      ...input, workflowId: "debug-failure", stageId: "verify", agentId: "auto-test-runner", workflowTask,
      stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
    } as StageExecutionInput;
    assert.match(verificationCompletionReason(verifierInput, []) ?? "", /successful governed verification command/iu);
    assert.match(verificationCompletionReason(verifierInput, [{ commandLine: "npm run check", exitCode: 1, timedOut: false }]) ?? "", /Verification command failed: npm run check \(exit code 1\)/iu);
  }
});

test("device delivery verification requires installation identity and launch receipts named by acceptance", () => {
  const verifyInput = {
    ...input,
    workflowId: "build-feature",
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Build the iOS app, install it on the iPhone, verify the installed bundle identity and launch.",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
  } as StageExecutionInput;
  const buildOnly = [{ commandLine: "xcodebuild build -scheme JarvisMobile", exitCode: 0, timedOut: false }];
  assert.match(verificationCompletionReason(verifyInput, buildOnly) ?? "", /requires device installation/iu);
  const installed = [...buildOnly, { commandLine: "ios-deploy --bundle /tmp/JarvisMobile.app", exitCode: 0, timedOut: false }];
  assert.match(verificationCompletionReason(verifyInput, installed) ?? "", /bundle identity evidence/iu);
  const inspected = [...installed, { commandLine: "xcrun devicectl device info apps --device phone-id", exitCode: 0, timedOut: false }];
  assert.equal(verificationCompletionReason(verifyInput, inspected), null);
});

test("successful devicectl delivery actions count as governed verification", () => {
  const actionResults = [
    { commandLine: "xcrun devicectl device install app --device phone-id build/JarvisMobile.app", exitCode: 0, timedOut: false },
    { commandLine: "xcrun devicectl device info apps --device phone-id", exitCode: 0, timedOut: false },
    { commandLine: "xcrun devicectl device process launch --device phone-id com.example.app", exitCode: 0, timedOut: false }
  ];
  assert.equal(verificationCompletionReason({
    ...input,
    workflowId: "build-feature",
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Build and install the iOS app on the device, verify the installed bundle identity, and launch it.",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] }
  } as StageExecutionInput, actionResults), null);
});

test("device acceptance combines prior implementation receipts with verifier receipts", () => {
  const priorInstall = {
    stageId: "implement",
    agentId: "implementation-agent",
    summary: "Installed the app.",
    artifact: {
      actionResults: [
        { commandLine: "xcodebuild build -scheme JarvisMobile", exitCode: 0, timedOut: false },
        { commandLine: "xcrun devicectl device install app --device phone-id build/JarvisMobile.app", exitCode: 0, timedOut: false }
      ]
    }
  };
  const verifierActions = [
    { commandLine: "xcrun devicectl device info apps --device phone-id", exitCode: 0, timedOut: false },
    { commandLine: "xcrun devicectl device process launch --device phone-id com.example.app", exitCode: 0, timedOut: false }
  ];
  assert.equal(verificationCompletionReason({
    ...input,
    workflowId: "build-feature",
    stageId: "verify",
    agentId: "auto-test-runner",
    workflowTask: "Build and install the iOS app on the device, verify the installed bundle identity, and launch it.",
    stagePattern: { type: "verifier", requiresVerifier: false, promotionGate: "evaluation", stopConditions: [] },
    priorStageArtifacts: [priorInstall]
  } as StageExecutionInput, verifierActions), null);
});
