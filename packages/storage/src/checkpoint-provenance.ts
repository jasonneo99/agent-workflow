import type pg from "pg";
import { acceptanceDigest, acceptanceGate, acceptanceProposal, historicalCheckpointAcceptanceDecision } from "./acceptance.js";
import type { StructuredAcceptanceContract } from "../../model-providers/src/types.js";

/** Validate historical execution, never promote its receipts into a new contract. */
export async function validateRecoveryCheckpoint(
  client: Pick<pg.Client, "query">,
  input: { runId: string; taskId: string; stageId: string; artifact: Record<string, unknown> | null },
  verifyChain?: (runId: string) => Promise<{ valid: boolean }>,
  visited = new Set<string>()
): Promise<void> {
  if (visited.has(input.runId) || visited.size >= 8) throw new Error("Recovery checkpoint ancestry is cyclic or exceeds eight hops.");
  visited.add(input.runId);
  if (!input.artifact || input.artifact.skipped === true) {
    throw new Error(`Recovery checkpoint ${input.stageId} requires original completed-stage evidence.`);
  }
  if (input.artifact.checkpointPreservedFromRunId) {
    if (!verifyChain) throw new Error("Recovery checkpoint requires original completed-stage ancestry validation.");
    const sourceRunId = input.artifact.checkpointPreservedFromRunId;
    const sourceTaskId = input.artifact.checkpointPreservedFromTaskId;
    if (typeof sourceRunId !== "string" || typeof sourceTaskId !== "string") throw new Error("Invalid recovery checkpoint ancestry identity.");
    const result = await client.query<{
      artifact: Record<string, unknown>; currentContract: StructuredAcceptanceContract; sourceContract: StructuredAcceptanceContract;
    }>(`select a.content as artifact, current_run.evaluation_metadata->'acceptanceContract' as "currentContract",
        source.evaluation_metadata->'acceptanceContract' as "sourceContract"
      from workflow_runs current_run join workflow_runs source on source.id::text=$2
        and source.project_id=current_run.project_id and source.task=current_run.task
        and source.workflow_definition_hash=current_run.workflow_definition_hash
      join workflow_tasks t on t.id::text=$3 and t.run_id=source.id and t.stage_id=$4 and t.status='completed'
      join artifacts a on a.uri=t.output_uri and a.run_id=t.run_id and a.task_id=t.id and a.kind='stage_output'
      where current_run.id=$1 and current_run.evaluation_metadata->'recoveryEvidence'->>'sourceRunId'=$2
        and current_run.evaluation_metadata->'recoveryEvidence'->>'mode'='historical-checkpoints-fresh-acceptance'`,
    [input.runId, sourceRunId, sourceTaskId, input.stageId]);
    const source = result.rows[0];
    if (!source?.currentContract || !source.sourceContract || !acceptanceProposal(source.currentContract, {
      ...source.sourceContract, contractId: source.currentContract.contractId, originRunId: source.currentContract.originRunId,
      subjectHash: source.currentContract.subjectHash
    })) throw new Error("Recovery checkpoint ancestry project, workflow or requirements mismatch.");
    const preserved = await client.query<{ metadata: Record<string, unknown> }>(
      `select metadata from action_receipts where run_id=$1 and target=$2 and action_type='stage_checkpoint_preserved'
       order by created_at desc limit 1`, [input.runId, input.taskId]);
    const attestation = preserved.rows[0]?.metadata;
    const expected = { ...source.artifact, checkpointPreservedFromRunId: sourceRunId, checkpointPreservedFromTaskId: sourceTaskId,
      checkpointEvidence: { mode: "historical-only", sourceArtifactHash: acceptanceDigest(source.artifact),
        sourceSubjectHash: source.sourceContract.subjectHash, freshAcceptanceRequired: true } };
    if (attestation?.sourceRunId !== sourceRunId || attestation.sourceTaskId !== sourceTaskId || attestation.stageId !== input.stageId
      || attestation.actionResolvedCheckpoint !== false || acceptanceDigest(expected) !== acceptanceDigest(input.artifact)
      || !(await verifyChain(sourceRunId)).valid) throw new Error("Recovery checkpoint ancestry attestation or receipt chain is invalid.");
    await validateRecoveryCheckpoint(client, { runId: sourceRunId, taskId: sourceTaskId, stageId: input.stageId, artifact: source.artifact }, verifyChain, visited);
    return;
  }
  const receipt = await client.query<{ metadata: Record<string, unknown> }>(
    `select metadata from action_receipts where run_id=$1 and target=$2 and action_type='stage_completed'
     order by created_at desc limit 1`, [input.runId, input.taskId]
  );
  if (!receipt.rows[0] || acceptanceDigest(receipt.rows[0].metadata) !== acceptanceDigest(input.artifact)) {
    throw new Error(`Recovery checkpoint ${input.stageId} does not match its completion receipt.`);
  }
  const gate = acceptanceGate(input.stageId);
  if (gate) {
    const decision = await historicalCheckpointAcceptanceDecision(client, input.runId, input.taskId, gate, input.artifact);
    if (decision.mode !== "structured" || decision.reason) {
      throw new Error(`Recovery checkpoint ${input.stageId} failed historical acceptance: ${decision.reason ?? "missing contract"}`);
    }
  }
}
