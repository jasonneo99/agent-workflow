import type pg from "pg";
import { appendActionReceipt } from "./receipt-writer.js";
import { transitionWorkflowRun } from "./run-transitions.js";
import { cancelRemainingWorkflowStages } from "./stage-lifecycle.js";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export type ApprovalWait = { version: 1; approvalIds: string[]; state: "waiting" | "resolved" | "declined"; since: string };

export type ExecutedPolicyAddition = { field: "allowed_commands" | "allowed_write_paths"; rule: string };
/** Supplemental executed decisions do not rewrite the frozen policy. A rule
 * removed from current project policy cannot be revived by an old approval.
 */
export function applyExecutedPolicyAdditions(snapshot: ProjectConfig, current: ProjectConfig, additions: ExecutedPolicyAddition[]): ProjectConfig {
  if (additions.length > 50) throw Error("Approved policy additions exceed their bounded review scope.");
  const actions = { ...snapshot.actions };
  for (const addition of additions) {
    if (!["allowed_commands","allowed_write_paths"].includes(addition.field) || typeof addition.rule !== "string"
      || !current.actions[addition.field].includes(addition.rule)) continue;
    actions[addition.field] = [...new Set([...actions[addition.field], addition.rule])];
  }
  return { ...snapshot, actions };
}

export function pendingActionApprovalIds(results: unknown[]): string[] {
  return [...new Set(results.flatMap(value => {
    const action = value as { type?: unknown; approvalId?: unknown } | null;
    return action && typeof action.type === "string" && action.type.endsWith("_approval_pending")
      && typeof action.approvalId === "string" && uuid.test(action.approvalId) ? [action.approvalId] : [];
  }))];
}

type Approval = { id: string; status: string; action_type: string; target: string; executed_at: unknown };
async function approvalsForTask(client: pg.Client, runId: string, taskId: string, ids: string[]): Promise<Approval[]> {
  const rows = (await client.query<Approval>(`select id::text,status,action_type,target,executed_at
    from action_approvals where run_id=$1::uuid and task_id=$2::uuid and id=any($3::uuid[])`, [runId, taskId, ids])).rows;
  if (rows.length !== ids.length) throw new Error("Approval wait requires exact same-run, same-task approval objects.");
  return rows;
}

function resolvedContinuation(continuation: Record<string, unknown>, approvals: Approval[]): Record<string, unknown> {
  const byId = new Map(approvals.map(approval => [approval.id, approval]));
  return { ...continuation,
    approvalWait: { ...(continuation.approvalWait as ApprovalWait), state: "resolved" },
    actionResults: (Array.isArray(continuation.actionResults) ? continuation.actionResults : []).map(value => {
      const action = value as { type?: string; approvalId?: string } | null;
      const approval = action?.approvalId ? byId.get(action.approvalId) : undefined;
      return approval && action?.type?.endsWith("_approval_pending")
        ? { ...action, type: "action_approval_resolved", originalType: action.type, status: approval.status,
          actionType: approval.action_type, target: approval.target,
          summary: "Approval execution is recorded. Consume its durable receipt; policy additions still require a fresh governed request for the previously denied action. Never replay an executed effect." }
        : value;
    }) };
}

/** Caller has validated the current worker/coordinator fence, locked the run,
 * and supplies its authoritative run epoch separately from the stage generation.
 * Waiting is unfinished work, never a failed output or authority to replay effects.
 */
export async function holdWorkflowTaskForApprovalsOnClient(client: pg.Client, input: {
  runId: string; taskId: string; agentId: string; workerId: string; fencingToken: string;
  approvalIds: string[]; continuation: Record<string, unknown>;
}, runLeaseEpoch: string): Promise<"waiting" | "resolved" | "declined"> {
  if (typeof runLeaseEpoch !== "string" || !/^(?:0|[1-9]\d*)$/u.test(runLeaseEpoch)) {
    throw new Error("Approval wait requires the locked workflow run lease epoch.");
  }
  const ids = [...new Set(input.approvalIds)];
  if (!ids.length || ids.length > 50 || ids.some(id => !uuid.test(id))) throw new Error("Invalid bounded approval wait.");
  const approvals = await approvalsForTask(client, input.runId, input.taskId, ids);
  if (approvals.some(approval => !["pending", "approved", "executing", "executed"].includes(approval.status))) return "declined";
  const resolved = approvals.every(approval => approval.status === "executed" && approval.executed_at);
  const rounds = Number(input.continuation.approvalWaitRounds ?? 0);
  if (!Number.isInteger(rounds) || rounds < 0 || rounds >= 20) throw new Error("Bounded approval-wait limit reached.");
  let continuation: Record<string, unknown> = { ...input.continuation, approvalWaitRounds: rounds + 1,
    approvalWait: { version: 1, approvalIds: ids, state: "waiting", since: new Date().toISOString() } satisfies ApprovalWait };
  if (resolved) continuation = resolvedContinuation(continuation, approvals);
  const content = JSON.stringify(continuation);
  if (Buffer.byteLength(content, "utf8") > 4_000_000) throw new Error("Approval checkpoint exceeds its storage bound.");
  const uri = `db://workflow_tasks/${input.taskId}/continuation`;
  await client.query(`insert into artifacts(run_id,task_id,kind,uri,content) values($1,$2,'stage_continuation',$3,$4::jsonb)
    on conflict(uri) do update set content=excluded.content`, [input.runId, input.taskId, uri, content]);
  await client.query(`update workflow_tasks set status='queued',started_at=null,finished_at=null,worker_id=null,lease_expires_at=null,
    available_at=case when $3::boolean then now() else 'infinity'::timestamptz end where id=$1::uuid and run_id=$2::uuid`,
  [input.taskId, input.runId, resolved]);
  await client.query(`update workflow_runs set lease_owner=null,lease_expires_at=null
    where id=$1::uuid and lease_owner=$2 and lease_epoch=$3::bigint
      and not exists(select 1 from workflow_tasks where run_id=$1::uuid and status in('leased','running'))`,
  [input.runId, input.workerId, runLeaseEpoch]);
  await appendActionReceipt(client, { runId: input.runId, agentId: input.agentId,
    actionType: resolved ? "stage_approval_resumed" : "stage_approval_held", target: input.taskId,
    summary: resolved ? "Approval execution already recorded; same unfinished stage queued for continuation."
      : "Awaiting approval. Progress retained; later stages remain queued.",
    metadata: JSON.stringify({ approvalIds: ids, uri, fencingToken: input.fencingToken, authority: "continuation-only" }) });
  return resolved ? "resolved" : "waiting";
}

/** Wake only a checkpoint explicitly held on these exact executed approvals.
 * Approve-only, unrelated decisions and terminal history cannot resume work.
 */
export async function resolveWorkflowApprovalWaitOnClient(client: pg.Client, approvalId: string): Promise<number> {
  const waits = (await client.query<{ runId: string; taskId: string; agentId: string; uri: string; content: Record<string, unknown> }>(
    `select wt.run_id::text as "runId",wt.id::text as "taskId",wt.agent_id as "agentId",a.uri,a.content
     from action_approvals approval join workflow_tasks wt on wt.id=approval.task_id and wt.run_id=approval.run_id
     join workflow_runs wr on wr.id=wt.run_id
     join artifacts a on a.run_id=wt.run_id and a.task_id=wt.id and a.kind='stage_continuation'
       and a.uri='db://workflow_tasks/'||wt.id::text||'/continuation'
     where approval.id=$1::uuid and wt.status='queued' and wt.available_at='infinity'::timestamptz
       and wt.worker_id is null and wt.lease_expires_at is null and wr.status in('queued','leased','running')
       and a.content#>>'{approvalWait,state}'='waiting'
       and (a.content#>'{approvalWait,approvalIds}') ? $1::text
     for update of wt,wr,a`, [approvalId])).rows;
  let resumed = 0;
  for (const wait of waits) {
    const ids = (wait.content.approvalWait as ApprovalWait).approvalIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => !uuid.test(id))) throw new Error("Invalid approval checkpoint binding.");
    const approvals = await approvalsForTask(client, wait.runId, wait.taskId, ids);
    const declined = approvals.find(approval => ["rejected", "failed", "dismissed", "expired"].includes(approval.status));
    if (declined) {
      const reason = `Required approval ${declined.id} is ${declined.status}; the requested action did not establish success.`;
      await client.query(`update artifacts set content=jsonb_set(content,'{approvalWait,state}','"declined"'::jsonb) where uri=$1`, [wait.uri]);
      await client.query(`update workflow_tasks set status='blocked',finished_at=now() where id=$1::uuid`, [wait.taskId]);
      await cancelRemainingWorkflowStages(client, { runId: wait.runId, exceptTaskId: wait.taskId, reason });
      await appendActionReceipt(client, { runId: wait.runId, agentId: wait.agentId, actionType: "stage_blocked", target: wait.taskId,
        summary: reason, metadata: JSON.stringify({ reason, approvalId: declined.id }) });
      await transitionWorkflowRun(client, { runId: wait.runId, to: "blocked", actor: "approval-executor", reason,
        idempotencyKey: `approval-wait-declined:${wait.taskId}:${declined.id}` });
    } else if (approvals.every(approval => approval.status === "executed" && approval.executed_at)) {
      await client.query(`update artifacts set content=$2::jsonb where uri=$1`, [wait.uri, JSON.stringify(resolvedContinuation(wait.content, approvals))]);
      await client.query(`update workflow_tasks set available_at=now() where id=$1::uuid`, [wait.taskId]);
      await appendActionReceipt(client, { runId: wait.runId, agentId: wait.agentId, actionType: "stage_approval_resumed", target: wait.taskId,
        summary: "Required approvals executed; the same unfinished stage can continue through normal worker gates.",
        metadata: JSON.stringify({ approvalIds: ids, uri: wait.uri, authority: "continuation-only" }) });
      resumed += 1;
    }
  }
  return resumed;
}
