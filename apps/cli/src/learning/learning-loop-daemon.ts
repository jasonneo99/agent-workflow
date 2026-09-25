import { loadAgents, loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { readLearningLoopState, runScheduledLearningExchange, type LearningLoopSchedulerReceipt } from "../../../../packages/learning-loop/src/index.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { createProviderLearningExchangeExecutor } from "./peer-exchange-provider.js";

export async function runDaemonLearningLoopSchedule(input: { projectDir: string; definitionsRoot: string }): Promise<LearningLoopSchedulerReceipt> {
  const state = await readLearningLoopState(input.projectDir);
  const today = new Date().toISOString().slice(0, 10);
  const agents = await loadAgents(input.definitionsRoot);
  const executor = createProviderLearningExchangeExecutor({ provider: providerFromEnv(), projectRootUri: input.projectDir, projectConfig: await loadProjectConfig(input.projectDir), agents });
  try {
    return await runScheduledLearningExchange({
      projectDir: input.projectDir,
      budget: {
        maxExchangesPerDay: positive(process.env.AGENTFLOW_LEARNING_LOOP_DAILY_LIMIT, 3),
        completedToday: state.schedulerReceipts.filter((receipt) => receipt.status === "completed" && receipt.completedAt.startsWith(today)).length,
        queueDepth: state.questions.filter((question) => !state.responses.some((response) => response.questionId === question.id)).length,
        maxQueueDepth: positive(process.env.AGENTFLOW_LEARNING_LOOP_MAX_QUEUE, 20),
        estimatedCostUsd: 0,
        maxDailyCostUsd: finite(process.env.AGENTFLOW_LEARNING_LOOP_DAILY_COST_USD, 1)
      },
      eligibleReviewerAgentIds: agents.map((agent) => agent.id),
      executor,
      deterministicChecksPassed: false,
      humanFeedbackConfirmed: false
    });
  } catch {
    return (await readLearningLoopState(input.projectDir)).schedulerReceipts.at(-1)!;
  }
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finite(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
