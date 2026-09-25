import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCard, ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import type { ModelProvider } from "../../../../packages/model-providers/src/types.js";
import { createLearningQuestion } from "../../../../packages/learning-loop/src/index.js";
import { createProviderLearningExchangeExecutor } from "./peer-exchange-provider.js";

const agent = (id: string): AgentCard => ({ id, display_name: id, category: "development", purpose: "test", model_strategy: "provider-agnostic", model_tier: "fast", autonomy: 1, use_when: [], avoid_when: [], can: [], cannot: [], requires_approval: [], context_budget: { max_tokens: 500, preferred_sources: [] }, outputs: { schema: "structured_summary" }, prompt: "Return bounded evidence." });
const projectConfig = { project: { id: "project", name: "Project", root_uri: "/tmp/project" } } as unknown as ProjectConfig;
const question = createLearningQuestion({ projectId: "project", taskClass: "test", requesterAgentId: "requester", respondentAgentId: "respondent", question: "What failed?", rubricVersion: "1", allowedEvidenceHashes: ["hash"], expiresAt: "2026-09-26T12:00:00.000Z", now: new Date("2026-09-25T12:00:00.000Z") });

test("provider adapter accepts structured read-only output", async () => {
  let call = 0;
  const instructions: string[] = [];
  const provider: ModelProvider = { id: "fixture", async executeStage(input) { call += 1; instructions.push(input.stageGoal); return { summary: call === 1 ? JSON.stringify({ answer: "A bounded answer", evidenceHashes: ["hash"], confidence: 0.8 }) : JSON.stringify({ scores: { correctness: 4, completeness: 4, evidenceQuality: 4, policyCompliance: 5, usefulness: 4, clarity: 4, verificationStrength: 4, uncertaintyHandling: 4 }, rationale: "Supported", evidenceHashes: ["hash"], confidence: 0.8 }), artifact: {} }; } };
  const executor = createProviderLearningExchangeExecutor({ provider, projectRootUri: "/tmp/project", projectConfig, agents: [agent("respondent"), agent("reviewer")] });
  const response = await executor.answer(question);
  assert.equal(response.answer, "A bounded answer");
  assert.equal((await executor.review({ question, response, reviewerAgentId: "reviewer" })).scores.policyCompliance, 5);
  assert.match(instructions[0] ?? "", /set summary to a JSON-encoded object/u);
  assert.match(instructions[1] ?? "", /Every score must be an integer from 1 through 5/u);
  assert.match(instructions[1] ?? "", /Response answer: A bounded answer/u);
});

test("provider adapter rejects command and file-write requests", async () => {
  const provider: ModelProvider = { id: "fixture", async executeStage() { return { summary: "{}", artifact: {}, requestedCommands: ["echo unsafe"] }; } };
  const executor = createProviderLearningExchangeExecutor({ provider, projectRootUri: "/tmp/project", projectConfig, agents: [agent("respondent")] });
  await assert.rejects(() => executor.answer(question), /prohibited side effect/u);
});

test("provider adapter accepts numeric strings from structured model output", async () => {
  const provider: ModelProvider = { id: "fixture", async executeStage() { return { summary: JSON.stringify({ answer: "Bounded", evidenceHashes: ["hash"], confidence: "0.75" }), artifact: {} }; } };
  const executor = createProviderLearningExchangeExecutor({ provider, projectRootUri: "/tmp/project", projectConfig, agents: [agent("respondent")] });
  assert.equal((await executor.answer(question)).confidence, 0.75);
});
