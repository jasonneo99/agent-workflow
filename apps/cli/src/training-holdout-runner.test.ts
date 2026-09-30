import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCard, ProjectConfig } from "../../../packages/agent-registry/src/schemas.js";
import type { ModelProvider } from "../../../packages/model-providers/src/types.js";
import { runTrainingHoldout, type TrainingHoldoutDesign } from "./training-holdout-runner.js";

const agent = (id: string): AgentCard => ({ id, display_name: id, category: "development", purpose: "test", model_strategy: "provider-agnostic", model_tier: "fast", autonomy: 1, use_when: [], avoid_when: [], can: [], cannot: [], requires_approval: [], context_budget: { max_tokens: 1000, preferred_sources: [] }, outputs: { schema: "structured_summary" }, prompt: "Read-only reviewer." });
const design: TrainingHoldoutDesign = { proposal: "proposal:hash", targets: ["reviewer"], fixture_contract: { common_prompt: "Review cases." }, cases: [
  { id: "bad", provider: "Example", label: "vulnerable", input: ["E1: unsafe"], expected: "find it", forbidden: "invent" },
  { id: "safe", provider: "Example", label: "safe", input: ["E1: safe"], expected: "no finding", forbidden: "flag it" }
] };

test("training holdout records paired observations and passes only measured improvement", async () => {
  const provider: ModelProvider = { id: "fixture", async executeStage(input) {
    if (input.agentId === "eval-curator") {
      const candidate = input.compiledBrief.includes("arm: candidate");
      return { summary: JSON.stringify({ judgments: [
        { caseId: "bad", finding: candidate, passed: candidate, evidenceLabels: ["E1"], providerErrors: 0, unsupportedFindings: 0, rationale: candidate ? "found" : "missed" },
        { caseId: "safe", finding: false, passed: true, evidenceLabels: ["E1"], providerErrors: 0, unsupportedFindings: 0, rationale: "safe" }
      ] }), artifact: {} };
    }
    return { summary: JSON.stringify({ responses: [] }), artifact: {} };
  } };
  const report = await runTrainingHoldout({ design, candidateContext: "candidate", agents: [agent("reviewer"), agent("eval-curator")], judge: agent("eval-curator"), projectConfig: {} as ProjectConfig, projectRootUri: "/tmp/project", provider, concurrency: 1 });
  assert.equal(report.measuredObservations, 4);
  assert.equal(report.metrics.baselineErrorsImproved, 1);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.usage.calls, 4);
});

test("training holdout rejects provider side effects", async () => {
  const provider: ModelProvider = { id: "fixture", async executeStage() { return { summary: "{}", artifact: {}, requestedCommands: ["echo no"] }; } };
  await assert.rejects(() => runTrainingHoldout({ design, candidateContext: "candidate", agents: [agent("reviewer"), agent("eval-curator")], judge: agent("eval-curator"), projectConfig: {} as ProjectConfig, projectRootUri: "/tmp/project", provider }), /prohibited side effect/u);
});
