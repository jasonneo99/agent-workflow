import type { StructuredAcceptanceContract } from "../../../../packages/model-providers/src/types.js";
import { acceptanceDigest } from "../../../../packages/storage/src/acceptance.js";
import { sourceSubjectHash } from "../../../../packages/workflow-engine/src/source-subject.js";
import type { Client } from "pg";

export interface ApprovedCommandRunBinding {
  runId: string;
  projectId: string;
  projectRootUri: string;
  task: string;
  contract?: StructuredAcceptanceContract;
  coordinatorClaimId?: string | null;
  coordinatorFence?: string | null;
}

/** Production work_intents.project_id is text; execution project IDs are UUID. */
export async function assertApprovedCommandCoordinatorAuthority(c: Pick<Client, "query">, run: ApprovedCommandRunBinding): Promise<void> {
  const live = await c.query(`select 1 from queue_coordinator_assignments q join work_intents i
    on i.project_id::text=q.project_id::text and i.owner=q.owner and i.fencing_token::text=q.intent_fence
    where q.id=$1::uuid and q.fence=$2::bigint and q.project_id::text=$3::text and q.child_run_id=$4::uuid
    and q.state in ('reserved','running') and i.file_scopes=q.file_scopes and q.file_scopes=$5::jsonb
    and i.expires_at>clock_timestamp()`, [run.coordinatorClaimId, run.coordinatorFence,
    run.projectId, run.runId, JSON.stringify(run.contract?.sourcePaths)]);
  if (!live.rowCount) throw new Error("Approved command requires its exact live coordinator claim, child and work intent.");
}

/** Frozen runtime enrollment supplies provenance, never the approval payload or provider. */
export async function executeSourceBoundApprovedCommand<T>(input: {
  run: ApprovedCommandRunBinding;
  approvalRunId: string;
  approvalProjectRootUri: string;
  localProjectRootUri: string;
  execute(): Promise<T>;
  assertCoordinatorAuthority?(): Promise<void>;
}, hash = sourceSubjectHash): Promise<{ result: T; evidence: Record<string, unknown>; sourceUnchanged: boolean }> {
  if (input.run.runId !== input.approvalRunId || input.run.projectRootUri !== input.approvalProjectRootUri) {
    throw new Error("Approved command run/project identity mismatch.");
  }
  const contract = input.run.contract;
  if (!contract) return { result: await input.execute(), evidence: {}, sourceUnchanged: true };
  if (contract.version !== 1 || contract.originRunId !== input.run.runId || contract.projectId !== input.run.projectId
    || contract.taskHash !== acceptanceDigest(input.run.task) || !contract.subjectHash || !contract.sourcePaths?.length) {
    throw new Error("Approved command requires an exact frozen acceptance identity and source scope.");
  }
  const sourcePaths = [...contract.sourcePaths];
  const coordinatorOwned = input.run.coordinatorClaimId !== undefined && input.run.coordinatorClaimId !== null;
  if (coordinatorOwned) {
    if (!input.run.coordinatorClaimId || !input.run.coordinatorFence || !input.assertCoordinatorAuthority) throw new Error("Approved command coordinator authority is unavailable.");
    await input.assertCoordinatorAuthority();
  }
  const sourceBefore = await hash(input.localProjectRootUri, sourcePaths);
  if (sourceBefore !== contract.subjectHash) throw new Error("Approved command source changed before execution.");
  const result = await input.execute();
  let sourceAfter: string | null = null;
  try { sourceAfter = await hash(input.localProjectRootUri, sourcePaths); } catch { /* Preserve the executed command, but never accept unavailable postimage proof. */ }
  let authorityValid = true;
  if (coordinatorOwned) try { await input.assertCoordinatorAuthority!(); } catch { authorityValid = false; }
  const sourceUnchanged = sourceAfter === contract.subjectHash && authorityValid;
  return { result, sourceUnchanged, evidence: { sourcePaths, sourceBefore, sourceAfter,
    subjectHash: sourceUnchanged ? sourceAfter : null, ...(coordinatorOwned ? { coordinatorAuthorityValid: authorityValid } : {}) } };
}
