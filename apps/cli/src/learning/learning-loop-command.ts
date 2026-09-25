import path from "node:path";
import type { Command } from "commander";
import { loadAgents, loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { createLearningQuestion, readLearningLoopState, runScheduledLearningExchange, writeLearningLoopState } from "../../../../packages/learning-loop/src/index.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { createProviderLearningExchangeExecutor } from "./peer-exchange-provider.js";

export function registerLearningLoopCommand(program: Command, definitionsRoot: string): void {
  program.command("learning-loop-question")
    .description("Queue a bounded read-only agent-to-agent learning question")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("--requester <agent>", "requesting agent id")
    .requiredOption("--respondent <agent>", "responding specialist agent id")
    .requiredOption("--task-class <class>", "bounded task class")
    .requiredOption("--question <text>", "question text")
    .requiredOption("--evidence-hash <hash...>", "allowed evidence hashes")
    .option("--expires-hours <hours>", "question expiry in hours", "24")
    .option("--run", "execute one provider-backed exchange immediately")
    .option("--json", "print the queued question or scheduler receipt as JSON")
    .action(async (options: { project: string; requester: string; respondent: string; taskClass: string; question: string; evidenceHash: string[]; expiresHours: string; run?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const now = new Date();
      const hours = Number.parseInt(options.expiresHours, 10);
      const question = createLearningQuestion({ projectId: projectDir, taskClass: options.taskClass, requesterAgentId: options.requester, respondentAgentId: options.respondent, question: options.question, rubricVersion: "1", allowedEvidenceHashes: options.evidenceHash, expiresAt: new Date(now.getTime() + (Number.isInteger(hours) && hours > 0 ? hours : 24) * 3_600_000).toISOString(), now });
      const state = await readLearningLoopState(projectDir);
      await writeLearningLoopState(projectDir, { ...state, questions: [...state.questions, question], updatedAt: now.toISOString() });
      if (!options.run) return void console.log(options.json ? JSON.stringify(question, null, 2) : `Queued ${question.id} for ${question.respondentAgentId}.`);
      const agents = await loadAgents(definitionsRoot);
      const executor = createProviderLearningExchangeExecutor({ provider: providerFromEnv(), projectRootUri: projectDir, projectConfig: await loadProjectConfig(projectDir), agents });
      const receipt = await runScheduledLearningExchange({ projectDir, budget: { maxExchangesPerDay: 1, completedToday: 0, queueDepth: 1, maxQueueDepth: 20, estimatedCostUsd: 0, maxDailyCostUsd: 1 }, eligibleReviewerAgentIds: agents.map((agent) => agent.id), executor });
      console.log(options.json ? JSON.stringify(receipt, null, 2) : `${receipt.status}: ${receipt.reason}`);
    });
}
