import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema, type AgentCard, type WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import { selectRelevantSourceSummaries } from "./index.js";

const project = projectConfigSchema.parse({
  project: {
    name: "Selector Test",
    summary: "Selector test project.",
    default_workflows: ["build-feature"],
    autonomy: 2
  }
});

const workflow: WorkflowDefinition = {
  id: "build-feature",
  name: "Build Feature",
  description: "Plan and implement a feature.",
  lead: "technical-architect",
  default_autonomy: 2,
  triggers: {
    manual: true,
    events: []
  },
  stages: [{
    id: "implement-api",
    agent: "backend-engineer",
    goal: "Implement API audit logging.",
    subagents: [],
    context: {
      load: [],
      max_tokens: 4000
    },
    approval_required: false,
    output: "summary"
  }]
};

const agents: AgentCard[] = [{
  id: "backend-engineer",
  display_name: "Backend Engineer",
  category: "development",
  purpose: "Implement API services.",
  model_strategy: "provider-agnostic",
  model_tier: "standard",
  autonomy: 2,
  use_when: ["API work"],
  avoid_when: [],
  can: ["Implement audit logging"],
  cannot: [],
  requires_approval: [],
  context_budget: {
    max_tokens: 2500,
    preferred_sources: []
  },
  outputs: {
    schema: "summary"
  },
  prompt: "Review backend code."
}];

test("source selection explains why a summary was included", () => {
  const selected = selectRelevantSourceSummaries({
    task: "Add API audit logging",
    project,
    workflow,
    agents,
    summaries: [
      {
        sourceUri: "src/api/audit.ts",
        tokenEstimate: 100,
        summary: "API audit logging utilities."
      },
      {
        sourceUri: "docs/style.md",
        tokenEstimate: 100,
        summary: "Writing style guidance."
      }
    ],
    maxFiles: 1,
    maxTokens: 500
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].sourceUri, "src/api/audit.ts");
  assert.match(selected[0].selectionReason, /path matched/);
  assert.match(selected[0].selectionReason, /summary matched/);
  assert.ok(selected[0].matchedTerms.includes("audit"));
});
