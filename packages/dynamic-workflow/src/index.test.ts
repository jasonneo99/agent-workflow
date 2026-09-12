import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema, workflowHandoffSchema } from "../../agent-registry/src/schemas.js";
import {
  constructDynamicWorkflow,
  definitionHash,
  selectWorkflowArchetype,
  stageTemplates,
  validateDynamicWorkflow,
  workflowArchetypes
} from "./index.js";

const project = projectConfigSchema.parse({
  project: { name: "Dynamic fixture", autonomy: 2 },
  context: { include: [], max_project_tokens: 7000 },
  policies: { require_receipts: true, require_approval_for_external_actions: true }
});

test("ships at least ten reusable archetypes backed by stage templates", () => {
  assert.ok(workflowArchetypes.length >= 10);
  for (const archetype of workflowArchetypes) {
    assert.ok(archetype.stages.length > 0);
    for (const stageId of archetype.stages) assert.ok(stageTemplates[stageId], `${archetype.id}:${stageId}`);
  }
});

test("selects a web app archetype from a natural-language goal", () => {
  assert.equal(selectWorkflowArchetype("Create me a local web app that tracks books").id, "web-app");
});

test("constructs a reproducible validated plan with policy controls and routing", () => {
  const plan = constructDynamicWorkflow({
    goal: "Create me a local web app that tracks books",
    project,
    now: "2026-01-02T03:04:05.000Z",
    changes: {
      parallel: [["frontend", "backend"]],
      providerBindings: { frontend: "openai", backend: "bedrock" },
      modelTierBindings: { frontend: "fast" },
      contextBudgets: { frontend: 50_000 },
      approvalStages: ["security"]
    }
  });
  assert.equal(plan.dynamic?.archetype, "web-app");
  assert.match(plan.dynamic?.definition_hash ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.dynamic?.mandatory_controls, [
    "project-action-allowlists",
    "destructive-action-boundary",
    "receipts-required",
    "external-actions-require-approval"
  ]);
  assert.equal(plan.stages.find((stage) => stage.id === "frontend")?.parallel_group, "parallel-1");
  assert.equal(plan.stages.find((stage) => stage.id === "backend")?.parallel_group, "parallel-1");
  assert.deepEqual(plan.stages.find((stage) => stage.id === "test")?.depends_on, ["frontend", "backend"]);
  assert.equal(plan.stages.find((stage) => stage.id === "frontend")?.routing?.provider, "openai");
  assert.equal(plan.stages.find((stage) => stage.id === "frontend")?.context.max_tokens, 7000);
  assert.equal(plan.stages.find((stage) => stage.id === "security")?.approval_required, true);
  assert.deepEqual(constructDynamicWorkflow({ goal: plan.dynamic!.goal, project, now: plan.dynamic!.generated_at }).dynamic?.definition_hash,
    constructDynamicWorkflow({ goal: plan.dynamic!.goal, project, now: plan.dynamic!.generated_at }).dynamic?.definition_hash);
});

test("allows bounded add, remove, repeat, reorder changes", () => {
  const plan = constructDynamicWorkflow({
    goal: "Fix a broken parser",
    project,
    now: "2026-01-02T03:04:05.000Z",
    changes: { remove: ["package"], add: [{ template: "security", after: "diagnose" }], repeat: [{ stage: "test", count: 2 }] }
  });
  assert.deepEqual(plan.stages.map((stage) => stage.id), ["triage", "diagnose", "security", "implement", "test", "test-2", "verify"]);
});

test("rejects removal or tampering of mandatory controls", () => {
  assert.throws(() => constructDynamicWorkflow({ goal: "Build an API", project, changes: { remove: ["verify"] } }), /Mandatory stage/);
  const plan = constructDynamicWorkflow({ goal: "Build an API", project, now: "2026-01-02T03:04:05.000Z" });
  plan.stages[0].goal = "tampered";
  assert.throws(() => validateDynamicWorkflow(plan, project), /definition hash/);
  const changedPolicy = projectConfigSchema.parse({ project: { name: "Dynamic fixture" }, policies: { require_receipts: false } });
  assert.throws(() => validateDynamicWorkflow(constructDynamicWorkflow({ goal: "Build an API", project, now: "2026-01-02T03:04:05.000Z" }), changedPolicy), /policy snapshot/);
});

test("rejects cyclic dynamic workflow dependencies", () => {
  const plan = constructDynamicWorkflow({ goal: "Build an API", project, now: "2026-01-02T03:04:05.000Z" });
  plan.stages[0].depends_on = [plan.stages.at(-1)!.id];
  plan.dynamic!.definition_hash = definitionHash(plan);
  assert.throws(() => validateDynamicWorkflow(plan, project), /dependency cycle/);
});

test("validates first-class handoff records", () => {
  const handoff = workflowHandoffSchema.parse({
    id: "handoff-1",
    run_id: "run-1",
    sender: "technical-architect",
    receiver: "implementation-agent",
    source_stage: "architecture",
    destination_stage: "implement",
    artifacts: ["artifact://plan"],
    context_summary: "Implement the accepted plan.",
    acceptance_criteria: ["All requested behavior is implemented"],
    proposed_at: "2026-01-02T03:04:05.000Z",
    updated_at: "2026-01-02T03:04:05.000Z",
    status: "proposed",
    receipt_links: ["receipt://proposal"]
  });
  assert.equal(handoff.attempt, 1);
  assert.throws(() => workflowHandoffSchema.parse({ ...handoff, acceptance_criteria: [] }));
});
