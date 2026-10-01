import { randomUUID } from "node:crypto";
import type { AgentCard, ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import { learningResponseSchema, peerAssessmentSchema, type LearningQuestion, type LearningResponse } from "../../../../packages/learning-loop/src/index.js";
import type { LearningExchangeExecutor } from "../../../../packages/learning-loop/src/runtime.js";
import type { ModelProvider, StageExecutionOutput } from "../../../../packages/model-providers/src/types.js";
import { estimateModelCost, modelPricingFromEnv } from "../../../../packages/fleet-model-gateway/src/index.js";

type ProviderExchangeInput = {
  provider: ModelProvider;
  projectRootUri: string;
  projectConfig: ProjectConfig;
  agents: AgentCard[];
};

export function createProviderLearningExchangeExecutor(input: ProviderExchangeInput): LearningExchangeExecutor {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));
  const usageTotals = { calls: 0, inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, costCoverageCalls: 0, unpricedCalls: 0 };
  const execute = async (agentId: string, question: LearningQuestion, stageId: string, instruction: string): Promise<Record<string, unknown>> => {
    const agent = byId.get(agentId);
    if (!agent) throw new Error(`Unknown learning-loop agent: ${agentId}`);
    const output = await input.provider.executeStage({
      runId: `learning-loop-${question.id}`,
      taskId: `${stageId}-${randomUUID()}`,
      projectRootUri: input.projectRootUri,
      projectConfig: input.projectConfig,
      workflowId: "learning-loop",
      workflowTask: question.question,
      stageId,
      agentId: agent.id,
      agentName: agent.display_name,
      agentPrompt: `${agent.purpose}\n${agent.prompt.slice(0, 1_200)}\nThis is a read-only peer-learning exchange. Never request commands or file writes.`,
      stageGoal: instruction,
      compiledBrief: `Allowed evidence hashes: ${question.allowedEvidenceHashes.join(", ")}`,
      modelTier: learningModelTier(),
      priorReceipts: [],
      priorStageArtifacts: [],
      memoryContext: []
    });
    rejectMutationRequests(output);
    recordUsage(output, usageTotals);
    return parseStructuredOutput(output);
  };

  return {
    providerId: input.provider.id,
    usage: () => {
      const { costUsd, ...measured } = usageTotals;
      return { ...measured, ...(usageTotals.costCoverageCalls ? { costUsd } : {}) };
    },
    async answer(question) {
      const instruction = "Answer the bounded question. In the required stage-result envelope, set summary to a JSON-encoded object with exactly answer, evidenceHashes, and confidence. Keep findings empty.";
      return executeStructured(execute, question.respondentAgentId, question, "answer", instruction, (value) => learningResponseSchema.parse({ id: `learning-response-${randomUUID()}`, questionId: question.id, respondentAgentId: question.respondentAgentId, answer: value.answer, evidenceHashes: value.evidenceHashes, confidence: numericValue(value.confidence), createdAt: new Date().toISOString() }));
    },
    async review({ question, response, reviewerAgentId }) {
      const instruction = [
        "Independently assess the response against the bounded question and allowed evidence hashes.",
        "In the required stage-result envelope, set summary to a JSON-encoded object with scores for correctness, completeness, evidenceQuality, policyCompliance, usefulness, clarity, verificationStrength, uncertaintyHandling; rationale; evidenceHashes; and confidence.",
        "Every score must be an integer from 1 through 5, never null. evidenceHashes must contain at least one hash from the allowlist. Use a low score and explain uncertainty when the hash-only evidence cannot prove a claim. Keep findings empty.",
        `Response id: ${response.id}`,
        `Response answer: ${response.answer.slice(0, 4_000)}`,
        `Response evidence hashes: ${response.evidenceHashes.join(", ")}`
      ].join("\n");
      return executeStructured(execute, reviewerAgentId, question, `review-${reviewerAgentId}`, instruction, (value) => peerAssessmentSchema.parse({ id: `learning-assessment-${randomUUID()}`, questionId: question.id, responseId: response.id, reviewerAgentId, respondentAgentId: response.respondentAgentId, scores: numericScoreRecord(value.scores), rationale: value.rationale, evidenceHashes: value.evidenceHashes, confidence: numericValue(value.confidence), createdAt: new Date().toISOString() }));
    }
  };
}

async function executeStructured<T>(
  execute: (agentId: string, question: LearningQuestion, stageId: string, instruction: string) => Promise<Record<string, unknown>>,
  agentId: string,
  question: LearningQuestion,
  stageId: string,
  instruction: string,
  validate: (value: Record<string, unknown>) => T
): Promise<T> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const repair = attempt === 0 ? "" : "\nREPAIR: The prior response was not valid structured output. Return only the requested JSON object with every required field and valid numeric values.";
      return validate(await execute(agentId, question, `${stageId}${attempt ? "-repair" : ""}`, `${instruction}${repair}`));
    } catch (error) {
      if (error instanceof Error && /prohibited side effect/u.test(error.message)) throw error;
      firstError ??= error;
    }
  }
  throw firstError;
}

function learningModelTier(): "fast" | "standard" | "reasoning" {
  const configured = process.env.AGENTFLOW_LEARNING_LOOP_MODEL_TIER;
  return configured === "standard" || configured === "reasoning" ? configured : "fast";
}

function recordUsage(output: StageExecutionOutput, total: { calls: number; inputTokens: number; cachedInputTokens: number; reasoningTokens: number; outputTokens: number; totalTokens: number; costUsd: number; costCoverageCalls: number; unpricedCalls: number }): void {
  total.calls += 1;
  const inputTokens = finite(output.usage?.inputTokens);
  const cachedInputTokens = finite(output.usage?.cachedInputTokens);
  const reasoningTokens = finite(output.usage?.reasoningTokens);
  const outputTokens = finite(output.usage?.outputTokens);
  total.inputTokens += inputTokens;
  total.cachedInputTokens += cachedInputTokens;
  total.reasoningTokens += reasoningTokens;
  total.outputTokens += outputTokens;
  total.totalTokens += finite(output.usage?.totalTokens) || inputTokens + outputTokens;
  const model = findModelId(output.artifact);
  const cost = typeof output.usage?.costUsd === "number" ? output.usage.costUsd : estimateModelCost({ inputTokens, cachedInputTokens, reasoningTokens, outputTokens, totalTokens: finite(output.usage?.totalTokens) || inputTokens + outputTokens }, model, modelPricingFromEnv());
  if (cost !== undefined) { total.costUsd += cost; total.costCoverageCalls += 1; }
  else total.unpricedCalls += 1;
}

function findModelId(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["model", "modelId", "model_id"]) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  for (const nested of Object.values(record)) {
    const model = findModelId(nested, depth + 1);
    if (model) return model;
  }
  return undefined;
}

function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function numericValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}
function numericScoreRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, score]) => [key, numericValue(score)]));
}

function rejectMutationRequests(output: StageExecutionOutput): void {
  if (output.requestedCommands?.length || output.requestedFileWrites?.length) throw new Error("Learning-loop provider requested a prohibited side effect.");
}

function parseStructuredOutput(output: StageExecutionOutput): Record<string, unknown> {
  const artifact = output.artifact.learningLoop;
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) return artifact as Record<string, unknown>;
  const match = output.summary.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("Learning-loop provider did not return structured JSON.");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Learning-loop provider returned invalid structured JSON.");
  return parsed as Record<string, unknown>;
}
