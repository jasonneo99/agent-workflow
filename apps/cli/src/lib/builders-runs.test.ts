import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTaskWorkflow } from "./builders-runs.js";

function agent(id: string, can: string[]) {
  return {
    id,
    display_name: id,
    category: "development",
    purpose: "Synthetic direct task",
    model_strategy: "provider-agnostic",
    model_tier: "standard",
    autonomy: 3,
    use_when: [],
    avoid_when: [],
    can,
    cannot: [],
    requires_approval: [],
    context_budget: { max_tokens: 1, preferred_sources: [] },
    outputs: { schema: "synthetic" },
    prompt: "Synthetic agent."
  } as never;
}

test("direct specialist tasks honor role-specific file editing capabilities", () => {
  assert.equal(createAgentTaskWorkflow(agent("backend-engineer", ["edit_backend_files"])).execution?.kind, "source-change");
  assert.equal(createAgentTaskWorkflow(agent("frontend-engineer", ["edit_frontend_files"])).execution?.kind, "source-change");
  assert.equal(createAgentTaskWorkflow(agent("implementation-agent", ["edit_local_files"])).execution?.kind, "source-change");
});

test("direct specialist tasks remain read-only without a file editing capability", () => {
  assert.equal(createAgentTaskWorkflow(agent("reviewer", ["inspect_logs"])).execution?.kind, "read-only");
});
