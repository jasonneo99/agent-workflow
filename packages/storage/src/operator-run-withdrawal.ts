import type { Client } from "pg";
import { withClient } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { appendActionReceipt } from "./receipt-writer.js";

export const WITHDRAW_RUN_CONFIRMATION = "Withdraw this exact run without accepting it.";
export interface WithdrawRunInput {
  projectId: string; runId: string; originatingThreadId: string; originalTaskDigest: string;
  owner: string; intentFence: string; actor: string; instruction: string; confirmation: string;
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
  if ((await client.query(`select 1 where
    exists(select 1 from workflow_tasks where run_id=$1::uuid and status in('queued','leased','running'))
    or exists(select 1 from action_approvals where run_id=$1::uuid and status in('pending','approved','executing','failed'))
    or exists(select 1 from queue_coordinator_assignments where (source_run_id=$1::uuid or child_run_id=$1::uuid) and state in('reserved','running','uncertain'))
    or exists(select 1 from side_effect_receipts where project_id=$1::text and status<>'completed')`, [input.runId])).rowCount) {
    throw Error("Stop or reconcile active work and unresolved effects before withdrawing this run.");
  }
  const uri = `db://workflow_runs/${input.runId}/operator_withdrawal`;
  const existing = (await client.query("select content from artifacts where run_id=$1::uuid and uri=$2 and kind='operator_run_withdrawal'", [input.runId,uri])).rows[0];
  if (existing) return uri;
  const content = { version:1,authority:"direct-human",disposition:"withdrawn-unaccepted",viewOnly:true,
    originalAcceptanceChanged:false,executionAuthorityGranted:false,runId:input.runId,projectId:input.projectId,
    originatingThreadId:input.originatingThreadId,originalTask:run.task,originalTaskDigest:input.originalTaskDigest,
    historicalStatus:run.status,actor:input.actor,instruction:input.instruction };
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
