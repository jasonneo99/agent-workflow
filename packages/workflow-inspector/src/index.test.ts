import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema, type AgentCard, type WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import { resolveExecutionPolicy } from "../../policy-engine/src/index.js";
import { buildWorkflowGraphReport, formatWorkflowGraphReport } from "./index.js";

const agents: AgentCard[] = [
  {
    id: "workflow-orchestrator",
    display_name: "Workflow Orchestrator",
    category: "core",
    purpose: "Coordinate workflows.",
    model_strategy: "provider-agnostic",
    model_tier: "standard",
    autonomy: 2,
    use_when: [],
    avoid_when: [],
    can: [],
    cannot: [],
    requires_approval: [],
    context_budget: { max_tokens: 2500, preferred_sources: [] },
    outputs: { schema: "summary" },
    prompt: "Coordinate work."
  },
  {
    id: "release-manager",
    display_name: "Release Manager",
    category: "operations",
    purpose: "Prepare releases.",
    model_strategy: "provider-agnostic",
    model_tier: "reasoning",
    autonomy: 4,
    use_when: [],
    avoid_when: [],
    can: [],
    cannot: [],
    requires_approval: ["deployment"],
    context_budget: { max_tokens: 2500, preferred_sources: [] },
    outputs: { schema: "summary" },
    prompt: "Review release readiness."
  }
];

const workflow: WorkflowDefinition = {
  id: "ship-release",
  name: "Ship Release",
  description: "Check release readiness.",
  lead: "release-manager",
  default_autonomy: 4,
  triggers: { manual: true, events: ["release_candidate_ready"] },
  stages: [
    {
      id: "readiness",
      agent: "workflow-orchestrator",
      goal: "Check readiness.",
      subagents: [],
      context: { load: ["commands"], max_tokens: 3000 },
      approval_required: false,
      output: "readiness"
    },
    {
      id: "go-no-go",
      agent: "release-manager",
      goal: "Recommend release.",
      subagents: ["workflow-orchestrator"],
      context: { load: ["readiness"], max_tokens: 2000 },
      approval_required: true,
      output: "decision"
    }
  ]
};

const project = projectConfigSchema.parse({
  project: {
    name: "Inspector Test",
    summary: "Inspector project.",
    default_workflows: ["ship-release"],
    autonomy: 4
  },
  policies: {
    allow_wide_open: false,
    require_approval_for_external_actions: true,
    require_receipts: true
  }
});

test("workflow graph report summarizes stages, dependencies, and approvals", () => {
  const report = buildWorkflowGraphReport({
    workflow,
    agents,
    project,
    resolvedPolicy: resolveExecutionPolicy(project, "local")
  });

  assert.equal(report.totals.stages, 2);
  assert.equal(report.totals.approvalStages, 1);
  assert.equal(report.totals.contextBudgetTokens, 5000);
  assert.deepEqual(report.stages[1].dependsOn, ["readiness"]);
  assert.match(report.mermaid, /flowchart TD/);
  assert.match(formatWorkflowGraphReport(report), /go-no-go -> release-manager/);
});

test("workflow graph report surfaces policy-blocked stages", () => {
  const report = buildWorkflowGraphReport({
    workflow,
    agents,
    project,
    resolvedPolicy: resolveExecutionPolicy(project, "production")
  });

  assert.equal(report.totals.blockedStages, 2);
  assert.match(report.warnings.join("\n"), /go-no-go is blocked by policy/);
});
