import type { ModelProvider, StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";
import { contextInfluence, influenceHash, type ContextInfluenceReference } from "../../project-evidence/src/influence.js";
import { recordRunAction } from "../../storage/src/postgres.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonHash } from "../../policy-engine/src/index.js";
import { ProviderExecutionError } from "../../model-providers/src/fallback.js";

export function stageContextInfluence(input: StageExecutionInput) {
  const references: ContextInfluenceReference[] = [];
  const historical = { observedAt: null, freshness: "historical" as const, confidence: "recorded" as const };
  for (const file of input.fileReads ?? []) references.push({ kind: "file", key: file.path, includedHash: influenceHash(file.content), sourceHash: file.sha256, ...historical, freshness: "unverified", target: { type: "file", value: file.path }, truncated: file.truncated });
  for (const artifact of input.priorStageArtifacts ?? []) references.push({ kind: "stage_artifact", key: artifact.stageId, includedHash: canonicalJsonHash(artifact), ...historical, target: { type: "run", value: input.runId } });
  for (const [index, receipt] of input.priorReceipts.entries()) references.push({ kind: "prior_receipt", key: `${receipt.agentId}:${receipt.actionType}:${index}`, includedHash: canonicalJsonHash(receipt), ...historical, target: { type: "run", value: input.runId } });
  for (const [index, delta] of (input.stateDeltas ?? []).entries()) references.push({ kind: "state_delta", key: String(index), includedHash: canonicalJsonHash(delta), ...historical });
  for (const [index, value] of (input.memoryContext ?? []).entries()) references.push({ kind: "memory_context", key: String(index), includedHash: influenceHash(value), ...historical });
  references.push({ kind: "agent", key: input.agentId, includedHash: influenceHash(input.agentPrompt), ...historical });
  references.push({ kind: "workflow", key: `${input.workflowId}:${input.stageId}`, includedHash: canonicalJsonHash({ task: input.workflowTask, goal: input.stageGoal, pattern: input.stagePattern ?? null }), ...historical });
  return contextInfluence(input.compiledBrief, references);
}

/** Wrap the existing provider call, including every read round and fallback.
 * A failed receipt write prevents the model invocation. No context body is copied.
 */
export function providerWithInfluence(provider: ModelProvider, record: typeof recordRunAction = recordRunAction): ModelProvider {
  const persist: typeof recordRunAction = async value => {
    try { return await record(value); }
    catch { throw new ProviderExecutionError("configuration", "Context attribution storage is unavailable; provider execution stopped."); }
  };
  return new Proxy(provider, { get(target, key) {
    if (key !== "executeStage") { const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value; }
    return async (input: StageExecutionInput): Promise<StageExecutionOutput> => {
      const influence = stageContextInfluence(input);
      const invocation = randomUUID();
      const uri = await persist({ runId: input.runId, taskId: input.taskId, agentId: input.agentId, actionType: "context_influence", target: input.stageId,
        summary: "Exact context prepared for this provider invocation.", artifactKind: "context_influence", idempotencyKey: invocation, artifactContent: { ...influence, phase: "provider_input", provider: target.id, stageId: input.stageId, taskId: input.taskId, invocationInputHash: canonicalJsonHash(input), compiledBriefUri: `db://workflow_runs/${input.runId}/compiled-brief` } });
      const output = await target.executeStage(input);
      await persist({ runId: input.runId, taskId: input.taskId, agentId: input.agentId, actionType: "context_influence_result", target: uri,
        summary: "Provider result linked to its recorded context.", artifactKind: "context_influence_result", idempotencyKey: `${invocation}-result`, artifactContent: { schemaVersion: 1, authority: "none", phase: "provider_result", stageId: input.stageId, influenceReceiptUri: uri, resultHash: canonicalJsonHash(output) } });
      return { ...output, artifact: { ...output.artifact, contextInfluenceReceiptUri: uri } };
    };
  } });
}
