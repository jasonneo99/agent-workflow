import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCard, ProjectConfig } from "../../../packages/agent-registry/src/schemas.js";
import type { ModelProvider } from "../../../packages/model-providers/src/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTrainingHoldoutDesign, isCompleteTrainingHoldoutReport, persistTrainingHoldoutDesign, runTrainingHoldout, type TrainingHoldoutDesign } from "./training-holdout-runner.js";

const agent = (id: string): AgentCard => ({ id, display_name: id, category: "development", purpose: "test", model_strategy: "provider-agnostic", model_tier: "fast", autonomy: 1, use_when: [], avoid_when: [], can: [], cannot: [], requires_approval: [], context_budget: { max_tokens: 1000, preferred_sources: [] }, outputs: { schema: "structured_summary" }, prompt: "Read-only reviewer." });
const design: TrainingHoldoutDesign = { proposal: "proposal:hash", targets: ["reviewer"], fixture_contract: { common_prompt: "Review cases." }, cases: [
  { id: "bad", provider: "Example", label: "vulnerable", input: ["E1: unsafe"], expected: "find it", forbidden: "invent" },
  { id: "safe", provider: "Example", label: "safe", input: ["E1: safe"], expected: "no finding", forbidden: "flag it" }
] };

test("training holdout records paired observations and passes only measured improvement", async () => {
  const provider: ModelProvider = { id: "fixture", async executeStage(input) {
    const candidate = input.compiledBrief.includes("Candidate training context");
    return { summary: JSON.stringify({ responses: [
      { caseId: "bad", finding: candidate, evidenceLabels: ["E1"], remediation: "fix", providerScope: "Example", providerErrors: 0, unsupportedFindings: 0, rationale: "review" },
      { caseId: "safe", finding: false, evidenceLabels: ["E1"], remediation: "", providerScope: "Example", providerErrors: 0, unsupportedFindings: 0, rationale: "safe" }
    ] }), artifact: {}, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  } };
  const report = await runTrainingHoldout({ design, candidateContext: "candidate", agents: [agent("reviewer")], projectConfig: {} as ProjectConfig, projectRootUri: "/tmp/project", provider, concurrency: 1 });
  assert.equal(report.measuredObservations, 4);
  assert.equal(report.metrics.baselineErrorsImproved, 1);
  assert.equal(report.verdict, "PASS");
  assert.equal(report.usage.calls, 2);
  assert.equal(isCompleteTrainingHoldoutReport(report), true);
});

test("training holdout rejects provider side effects", async () => {
  const provider: ModelProvider = { id: "fixture", async executeStage() { return { summary: "{}", artifact: {}, requestedCommands: ["echo no"] }; } };
  await assert.rejects(() => runTrainingHoldout({ design, candidateContext: "candidate", agents: [agent("reviewer")], projectConfig: {} as ProjectConfig, projectRootUri: "/tmp/project", provider }), /prohibited side effect/u);
});

test("training holdout design is deterministic, adversarial, and persisted", async () => {
  const generated = buildTrainingHoldoutDesign({ id: "source:hash", targets: ["a", "b", "c", "d", "e"], publisher: "Standards body", claimedBenefit: "detect missing proof", risks: "do not overclaim", holdoutEvaluation: "require cited provenance" });
  assert.deepEqual(generated.targets, ["a", "b", "c", "d"]);
  assert.equal(generated.cases.length, 4);
  assert.deepEqual([...new Set(generated.cases.map((item) => item.label))].sort(), ["safe", "vulnerable"]);
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-holdout-design-"));
  const designPath = await persistTrainingHoldoutDesign(projectDir, generated);
  assert.equal(JSON.parse(await fs.readFile(designPath, "utf8")).proposal, "source:hash");
});

test("zero and partial measurement reports are not complete evidence", () => {
  const report = { plannedObservations: 4, measuredObservations: 0, observations: [] } as never;
  assert.equal(isCompleteTrainingHoldoutReport(report), false);
});
