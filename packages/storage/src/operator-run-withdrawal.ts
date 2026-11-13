import type { Client } from "pg";
import { withClient } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { appendActionReceipt } from "./receipt-writer.js";

export const WITHDRAW_RUN_CONFIRMATION = "Withdraw this exact run without accepting it.";
export interface WithdrawRunInput {
  projectId: string; runId: string; originatingThreadId: string; originalTaskDigest: string;
  owner: string; intentFence: string; actor: string; instruction: string; confirmation: string;
}

function deterministicParserRejection(error:unknown):boolean {
  return typeof error === "string" && (
    /^File patch rejected: hunk count mismatch; expected -\d+\/\+\d+, received -\d+\/\+\d+\.$/u.test(error)
    || /^File patch rejected: unsupported hunk line: .+$/u.test(error)
    || /^File patch rejected: stale preimage hash for .+; expected [a-f0-9]{64}, found [a-f0-9]{64}\.$/u.test(error)
    || /^File patch rejected: (?:context|removal) mismatch at old line \d+;/u.test(error)
  );
}

/** Reconcile only expired file-write claims that have one unambiguous parser
 * rejection before the next same-target claim and no matching write artifact.
 * This records a no-effect disposition; it never reports successful execution.
 */
async function reconcileExpiredPrewriteClaims(client:Client,runId:string):Promise<number>{
  const claims=(await client.query(`select idempotency_key,target,created_at,claim_expires_at
    from side_effect_receipts where project_id=$1::text and operation='file_write' and status in('pending','uncertain')
      and claim_expires_at<=clock_timestamp() for update`,[runId])).rows;
  let reconciled=0;
  for(const claim of claims){
    const rejection=(await client.query(`select ar.metadata,a.uri from action_receipts ar join artifacts a
      on a.run_id=ar.run_id and a.content=ar.metadata and a.kind='action_rejection'
      where ar.run_id=$1::uuid and ar.action_type='file_write_rejected' and ar.target=$2
        and ar.created_at>=$3 and ar.created_at<coalesce((select min(next.created_at) from side_effect_receipts next
          where next.project_id=$1::text and next.target=$2 and next.idempotency_key<>$4 and next.created_at>$3),$5)
      order by ar.created_at`,[runId,claim.target,claim.created_at,claim.idempotency_key,claim.claim_expires_at])).rows;
    if(rejection.length!==1||!deterministicParserRejection(rejection[0].metadata?.error))continue;
    if((await client.query(`select 1 from artifacts where run_id=$1::uuid and kind='file_write'
      and content->>'idempotencyKey'=$2 limit 1`,[runId,claim.idempotency_key])).rowCount)continue;
    const receipt={version:1,noEffect:true,reason:'deterministic-prewrite-parser-rejection',
      rejectionArtifactUri:rejection[0].uri,idempotencyKey:claim.idempotency_key,target:claim.target};
    const changed=await client.query(`update side_effect_receipts set status='rejected',receipt=$3::jsonb,claim_token=null,claim_expires_at=null
      where project_id=$1::text and idempotency_key=$2 and status in('pending','uncertain')`,[runId,claim.idempotency_key,JSON.stringify(receipt)]);
    if(changed.rowCount!==1)continue;
    await appendActionReceipt(client,{runId,agentId:'workflow-orchestrator',actionType:'expired_prewrite_reservation_reconciled',
      target:claim.idempotency_key,summary:'Expired write reservation matched one deterministic pre-write parser rejection; no write occurred.',metadata:JSON.stringify(receipt)});
    reconciled++;
  }
  return reconciled;
}

/** Direct human withdrawal is distinct from archiving a successfully replaced
 * contract. It grants no recovery/acceptance authority and never erases history.
 */
export async function withdrawUnacceptedRunOnClient(client: Client, input: WithdrawRunInput): Promise<string> {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
  if (![input.projectId,input.runId,input.originatingThreadId].every(id => uuid.test(id))
    || !/^[a-f0-9]{64}$/u.test(input.originalTaskDigest) || !input.actor.trim() || !input.instruction.trim()
    || input.confirmation !== WITHDRAW_RUN_CONFIRMATION) throw Error("Exact direct-human run withdrawal required.");
  await client.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
  const run = (await client.query(`select id::text,project_id::text,task,status,evaluation_metadata
    from workflow_runs where id=$1::uuid and project_id=$2::uuid for update`, [input.runId,input.projectId])).rows[0];
  if (!run || !["blocked","failed","cancelled"].includes(run.status)
    || run.evaluation_metadata?.codexThreadId !== input.originatingThreadId
    || acceptanceDigest(run.task) !== input.originalTaskDigest || run.evaluation_metadata?.acceptance === "accepted") {
    throw Error("Withdrawal requires the exact unaccepted terminal run in its originating chat.");
  }
  if (!(await client.query(`select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token=$3::bigint
    and expires_at>clock_timestamp() and file_scopes=$4::jsonb for update`,
  [input.projectId,input.owner,input.intentFence,JSON.stringify([`runtime/withdrawals/${input.runId}`])])).rowCount) throw Error("Fresh exact withdrawal intent required.");
  const reconciledPrewriteClaims=await reconcileExpiredPrewriteClaims(client,input.runId);
  const unresolved = await client.query(`select 1 where
    exists(select 1 from workflow_tasks where run_id=$1::uuid and status in('queued','leased','running'))
    or exists(select 1 from action_approvals where run_id=$1::uuid and status in('pending','approved','executing','failed'))
    or exists(select 1 from queue_coordinator_assignments where (source_run_id=$1::uuid or child_run_id=$1::uuid) and state in('reserved','running'))
    or exists(select 1 from queue_coordinator_assignments q left join workflow_runs child on child.id=q.child_run_id
      where (q.source_run_id=$1::uuid or q.child_run_id=$1::uuid) and q.state='uncertain' and (
        q.child_run_id is null or child.status not in('blocked','failed','cancelled','completed')
        or exists(select 1 from workflow_tasks where run_id=q.child_run_id and status in('queued','leased','running'))
        or exists(select 1 from action_approvals where run_id=q.child_run_id and status in('pending','approved','executing','failed'))))
    or exists(select 1 from side_effect_receipts where project_id=$1::text and status not in('completed','rejected'))`, [input.runId]);
  if (unresolved.rowCount) {
    throw Error("Stop or reconcile active work and unresolved effects before withdrawing this run.");
  }
  // A terminal child can leave its coordinator reservation uncertain when the
  // process exits after cancellation. The exact human withdrawal is allowed to
  // close only that quiescent reservation; it does not accept or replay either
  // run and does not change their terminal statuses.
  await client.query(`update queue_coordinator_assignments set state='held'
    where (source_run_id=$1::uuid or child_run_id=$1::uuid) and state='uncertain'`,[input.runId]);
  const uri = `db://workflow_runs/${input.runId}/operator_withdrawal`;
  const existing = (await client.query("select content from artifacts where run_id=$1::uuid and uri=$2 and kind='operator_run_withdrawal'", [input.runId,uri])).rows[0];
  if (existing) return uri;
  const content = { version:1,authority:"direct-human",disposition:"withdrawn-unaccepted",viewOnly:true,
    originalAcceptanceChanged:false,executionAuthorityGranted:false,runId:input.runId,projectId:input.projectId,
    originatingThreadId:input.originatingThreadId,originalTask:run.task,originalTaskDigest:input.originalTaskDigest,
    historicalStatus:run.status,coordinatorUncertaintyClosed:true,reconciledPrewriteClaims,actor:input.actor,instruction:input.instruction };
  await client.query("insert into artifacts(run_id,kind,uri,content) values($1::uuid,'operator_run_withdrawal',$2,$3::jsonb)", [input.runId,uri,JSON.stringify(content)]);
  await appendActionReceipt(client, { runId:input.runId,agentId:"workflow-orchestrator",actionType:"workflow_run_withdrawn",target:input.runId,
    summary:"Direct human withdrew this exact unsuccessful run. History is retained; no acceptance, replay or replacement authority is inferred.",metadata:JSON.stringify(content) });
  return uri;
}

export const withdrawUnacceptedRun = (input: WithdrawRunInput) => withClient(async client => {
  await client.query("begin");
  try { const uri = await withdrawUnacceptedRunOnClient(client,input); await client.query("commit"); return uri; }
  catch (error) { await client.query("rollback"); throw error; }
});
