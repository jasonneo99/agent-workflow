import { randomUUID } from "node:crypto";
import type http from "node:http";
import { withClient } from "../../../../packages/storage/src/client.js";
import { acquireWorkIntent, releaseWorkIntent, claimSideEffect, finalizeSideEffect, listWorkflowQueue, recordRunAction } from "../../../../packages/storage/src/postgres.js";
import { computeReceiptHash } from "../../../../packages/workflow-engine/src/receipt-chain.js";
import { assertGenericRunRecoveryAllowed } from "../../../../packages/storage/src/managed-run-recovery.js";
import { sanitizeAssistantText } from "../../../../packages/conversation-contract/src/index.js";
import { isTrustedLocalDashboardRequest } from "../dashboard/question-chat.js";
import { partnerHash, proposedQueueFix, type PartnerApproval, type PartnerChatAdapter, type PartnerItem, type PartnerProposal, type PartnerReply } from "./queue-partner-chat.js";

export function isTrustedPartnerCommandRequest(request: http.IncomingMessage): boolean {
  if (!isTrustedLocalDashboardRequest(request) || request.headers["x-agentflow-queue-partner"] !== "1" || !String(request.headers["content-type"] ?? "").startsWith("application/json")) return false;
  try {
    const origin = request.headers.origin;
    return origin === undefined || (typeof origin === "string" && new URL(origin).origin === new URL(`http://${request.headers.host}`).origin);
  } catch { return false; }
}

type Effects = Pick<PartnerChatAdapter, "repair" | "approve" | "converse"> & Pick<PartnerChatAdapter, "stop">;
/** Authenticate this new proposal receipt, not acceptance of unrelated historical work. */
export function partnerProposalReceiptMatches(runId: string, proposal: unknown, receipt: Record<string, unknown>, actionType: "queue_partner_approval_proposed" | "queue_partner_operator_repair_requested" = "queue_partner_approval_proposed"): boolean {
  if (receipt.metadata_serialization_version !== 2 || typeof receipt.prev_hash !== "string" || typeof receipt.receipt_hash !== "string" || partnerHash(proposal) !== partnerHash(receipt.metadata)) return false;
  try { return computeReceiptHash(receipt.prev_hash, { runId, agentId: "workflow-orchestrator", actionType, target: String(receipt.target), summary: String(receipt.summary), metadata: JSON.stringify(receipt.metadata), metadataSerializationVersion: 2, createdAt: receipt.created_at instanceof Date ? receipt.created_at.toISOString() : new Date(String(receipt.created_at)).toISOString() }) === receipt.receipt_hash; } catch { return false; }
}

/** Decision state alone is not proof of an applied effect (legacy skips used executed). */
export function partnerApprovalEffectMatches(row:Record<string,any>):boolean{
 const expected:Record<string,string>={partner_recovery_admission:'partner_recovery_admission',local_command:'command_output',file_write:'file_write',executor_adapter:'executor_output',context_correction:'context_correction',project_policy_change:'project_policy_change',object_mirror:'object_mirror',artifact_archive:'archived_artifact',artifact_restore:'restored_artifact'};
 if(row.status!=='executed'||!expected[row.approval_action]||row.kind!==expected[row.approval_action]||row.content?.skipped===true||row.metadata?.approvalId!==row.approval_id||row.metadata?.actionType!==row.approval_action||row.metadata?.status!=='executed'||row.metadata?.artifactUri!==row.artifact_uri||row.target!==row.approval_target||row.metadata_serialization_version!==2)return false;
 if(row.approval_action==='local_command'&&(row.content?.exitCode!==0||row.content?.timedOut===true))return false;
 if(row.approval_action==='executor_adapter'&&row.content?.execution?.status!=='passed')return false;
 try{return computeReceiptHash(row.prev_hash,{runId:row.run_id,agentId:row.agent_id,actionType:'action_approval_executed',target:row.target,summary:row.summary,metadata:JSON.stringify(row.metadata),metadataSerializationVersion:2,createdAt:row.created_at instanceof Date?row.created_at.toISOString():new Date(row.created_at).toISOString()})===row.receipt_hash;}catch{return false;}
}
export async function hasPartnerApprovalEffect(projectId:string,approvalId:string):Promise<boolean>{
 return withClient(async c=>{
  const row=(await c.query(`select aa.id::text approval_id,aa.action_type approval_action,aa.target approval_target,aa.status,
   r.id::text run_id,rc.agent_id,rc.target,rc.summary,rc.metadata,rc.created_at,rc.metadata_serialization_version,rc.prev_hash,rc.receipt_hash,a.uri artifact_uri,a.kind,a.content
   from action_approvals aa join workflow_runs r on r.id=aa.run_id
   join action_receipts rc on rc.run_id=r.id and rc.agent_id=aa.agent_id and rc.action_type='action_approval_executed' and rc.metadata->>'approvalId'=aa.id::text
   join artifacts a on a.run_id=r.id and a.uri=rc.metadata->>'artifactUri'
   where aa.id=$1::uuid and r.project_id=$2::uuid order by rc.created_at desc limit 1`,[approvalId,projectId])).rows[0];
  return Boolean(row&&partnerApprovalEffectMatches(row));
 });
}

/** A bounded authenticated operator inbox. This grants no replay or repair authority. */
export async function loadPartnerOperatorRequests(projectIds: string[]): Promise<Array<{ projectId: string; runId: string }>> {
  if (!projectIds.length) return [];
  return withClient(async c => {
    const rows = (await c.query(`select r.id::text as "receiptRunId",r.project_id::text as "projectId",coalesce(parent.id,r.id)::text as "sourceRunId",a.content,
      rc.target,rc.summary,rc.metadata,rc.created_at,rc.metadata_serialization_version,rc.prev_hash,rc.receipt_hash
      from artifacts a join workflow_runs r on r.id=a.run_id
      left join workflow_runs parent on parent.id::text=r.evaluation_metadata->>'sourceRunId' and parent.project_id=r.project_id
      join action_receipts rc on rc.run_id=r.id and rc.agent_id='workflow-orchestrator' and rc.action_type='queue_partner_operator_repair_requested' and rc.target=r.id::text and rc.metadata=a.content
      where r.project_id=any($1::uuid[]) and a.kind='queue_partner_operator_instruction'
      and a.content->>'projectId'=r.project_id::text and a.content->>'runId'=r.id::text
      and a.content->>'version'='1' and a.content->>'channel'='authenticated-local-dashboard' and a.content->>'action'='repair' and a.content->>'guardsUnchanged'='true'
      and rc.created_at>=clock_timestamp()-interval '24 hours' and rc.created_at<=clock_timestamp()
      order by rc.created_at desc limit 100`, [projectIds])).rows;
    const seen = new Set<string>();
    return rows.filter(r => partnerProposalReceiptMatches(r.receiptRunId, r.content, r, "queue_partner_operator_repair_requested")).flatMap(r => {
      const key = `${r.projectId}:${r.sourceRunId}`;
      if (seen.has(key)) return []; seen.add(key); return [{ projectId: r.projectId, runId: r.sourceRunId }];
    });
  });
}
export function createPartnerChatAdapter(projectId: string, root: string, effects: Effects, canAct = true): PartnerChatAdapter {
  const safe = (value: unknown, max = 500) => sanitizeAssistantText(value, max);
  const rowItem = (r: Record<string, unknown>): PartnerItem => {
    const blocker = safe(r.blocker), approvalCount = Number(r.approvalCount ?? 0);
    return { runId: String(r.runId), projectId: String(r.projectId), title: safe(r.title, 180), status: String(r.status), blocker, approvalCount, proposedFix: proposedQueueFix(blocker, approvalCount) };
  };
  const selectItems = (ids: string[]) => withClient(async c => (await c.query(`select r.id::text as "runId",r.project_id::text as "projectId",r.status,
    left(coalesce(r.construction_rationale->'presentation'->>'title',r.task),500) title,
    (select left(coalesce(a.metadata->>'reason',a.summary),1200) from action_receipts a where a.run_id=r.id and a.action_type in ('stage_blocked','stage_failed') order by a.created_at desc limit 1) blocker,
    (select count(*)::int from action_approvals aa where aa.run_id=r.id and aa.status in ('pending','approved','executing','failed')) as "approvalCount"
    from workflow_runs r where r.project_id=$1::uuid and r.id=any($2::uuid[])`, [projectId, ids])).rows.map(rowItem));
  const approvalRows = (runId?: string, id?: string) => withClient(async c => (await c.query(`select a.id::text,a.run_id::text as "runId",r.project_id::text as "projectId",a.status,a.action_type as "actionType",a.target,
    jsonb_build_object('request',a.payload,'policy',a.policy_decision,'taskId',a.task_id,'stageId',a.stage_id) payload
    from action_approvals a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and ($2::uuid is null or a.run_id=$2::uuid) and ($3::uuid is null or a.id=$3::uuid)
    order by a.created_at desc limit 101`, [projectId, runId ?? null, id ?? null])).rows as PartnerApproval[]);
  const intent = async <T>(fn: () => Promise<T>): Promise<T> => {
    const owner = `queue-partner-chat:${randomUUID()}`;
    const claim = await acquireWorkIntent({ projectId, owner, objective: "Apply one authenticated project-scoped Queue Partner instruction", fileScopes: ["runtime/queue-partner/instructions"], ttlSeconds: 900 });
    try { return await fn(); } finally { await releaseWorkIntent({ projectId, owner, fencingToken: claim.fencingToken }); }
  };
  const adapter: PartnerChatAdapter = {
    canAct: () => canAct,
    async items() {
      const queue = await listWorkflowQueue(100, { projectRootUri: root, latestRelated: true });
      const ids = queue.map(card => card.runId), rows = await selectItems(ids);
      return ids.map(id => rows.find(r => r.runId === id)).filter((r): r is PartnerItem => Boolean(r)).filter(r => ["blocked", "failed", "running", "queued", "leased"].includes(r.status));
    },
    async item(runId) { return (await selectItems([runId]))[0] ?? null; },
    approvals: runId => approvalRows(runId),
    async approval(id) { return (await approvalRows(undefined, id))[0] ?? null; },
    async saveProposal(proposal) {
      await intent(async () => { await recordRunAction({ runId: proposal.runId, agentId: "workflow-orchestrator", actionType: "queue_partner_approval_proposed", target: proposal.id,
        summary: "Authenticated local operator was shown one exact project/run-bound approval proposal.", artifactKind: "queue_partner_approval_proposal",
        artifactContent: { ...proposal, version: 1, channel: "authenticated-local-dashboard" }, idempotencyKey: `proposal-${proposal.id}` }); });
    },
    async proposal(id) {
      return withClient(async c => {
        const rows = (await c.query(`select a.run_id::text,a.content from artifacts a join workflow_runs r on r.id=a.run_id
          where r.project_id=$1::uuid and a.kind='queue_partner_approval_proposal' and a.content->>'id'=$2 limit 2`, [projectId, id])).rows;
        if (rows.length !== 1) return null;
        const row = rows[0], p = row.content;
        if (p.version !== 1 || p.channel !== "authenticated-local-dashboard" || p.projectId !== projectId || p.runId !== row.run_id || p.id !== id ||
          !["conversationId", "runId", "approvalId", "approvalHash", "summary", "disclosure", "expiresAt"].every(k => typeof p[k] === "string") || p.disclosure.length>12000) return null;
        const linked = (await c.query(`select target,summary,metadata,created_at,metadata_serialization_version,prev_hash,receipt_hash from action_receipts where run_id=$1::uuid and agent_id='workflow-orchestrator' and action_type='queue_partner_approval_proposed' and target=$2 order by created_at desc limit 2`, [row.run_id, id])).rows;
        if (linked.length !== 1 || !partnerProposalReceiptMatches(row.run_id, p, linked[0])) return null;
        return { id: p.id, conversationId: p.conversationId, projectId, runId: p.runId, approvalId: p.approvalId, approvalHash: p.approvalHash, summary: p.summary, disclosure:p.disclosure, expiresAt: p.expiresAt } as PartnerProposal;
      });
    },
    async once(key, requestHash, runId, action) {
      return intent(async () => {
        const idempotencyKey = `queue-partner-chat:${partnerHash(key)}`;
        const claim = await claimSideEffect({ projectId, idempotencyKey, operation: "queue-partner-chat", target: runId, claimSeconds: 900 });
        if (claim.status === "completed") {
          if (claim.receipt.requestHash !== requestHash || !claim.receipt.reply) return { kind: "queue_partner_chat_report", status: "blocked", text: "This request key belongs to a different instruction. Nothing new was started.", items: [] };
          return { ...(claim.receipt.reply as PartnerReply), replayed: true };
        }
        if (claim.status !== "claimed" || !claim.claimToken) return { kind: "queue_partner_chat_report", status: "review", text: "This instruction is already in progress or its outcome needs reconciliation. Check the item before retrying; no duplicate action was started.", items: [] };
        try {
          const reply = await action();
          await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "queue_partner_operator_command", target: idempotencyKey,
            summary: `Authenticated Queue Partner instruction returned ${reply.status}; completion of this instruction is not acceptance of the product outcome.`, artifactKind: "queue_partner_operator_command",
            artifactContent: { version: 1, projectId, runId, requestHash, status: reply.status, resultRunId: reply.runId ?? null, channel: "authenticated-local-dashboard" }, idempotencyKey });
          const settled = await finalizeSideEffect({ projectId, idempotencyKey, claimToken: claim.claimToken, receipt: { requestHash, reply } });
          return settled ? reply : { kind: "queue_partner_chat_report", status: "review", text: "The instruction returned, but its delivery claim changed. Reconcile the recorded result before retrying.", items: [] };
        } catch {
          // Never clear or refund an uncertain claim: the effect may already have happened.
          return { kind: "queue_partner_chat_report", status: "review", text: "The service could not confirm the instruction's outcome. Inspect the item's receipts before retrying; it was not automatically repeated.", items: [] };
        }
      });
    },
    async repair(item, message) {
      const state = await withClient(async c => {
        const row = (await c.query('select evaluation_metadata from workflow_runs where id=$1::uuid and project_id=$2::uuid', [item.runId, projectId])).rows[0];
        if (!row) throw Error("Project item changed.");
        const active = (await c.query(`select id::text from workflow_runs where project_id=$1::uuid and status in ('queued','leased','running') and evaluation_metadata->>'sourceRunId'=$2 limit 1`, [projectId, item.runId])).rows[0];
        return { metadata: row.evaluation_metadata ?? {}, active };
      });
      if (state.active) return { status: "queued", runId: state.active.id, text: "A related repair is already queued or running. I kept that attempt instead of starting a duplicate." };
      if (state.metadata.suiteId || state.metadata.evaluationId || /eval(?:uation)?|training/iu.test(String(state.metadata.source ?? ""))) return { status: "blocked", text: "Evaluation or training requires its own explicit scope and budget. No paid evaluation or training was started." };
      if (state.metadata.source === "blocked-run-repair") return { status: "blocked", text: "This is already a recovery attempt. Continue its existing family rather than creating a repair-of-repair child." };
      let managed = false;
      await withClient(async c => { try { await assertGenericRunRecoveryAllowed(c, item.runId, "replay"); } catch (error) { if (error instanceof Error && error.message.startsWith("Generic replay is forbidden for Partner-managed")) managed = true; else throw error; } });
      if (!managed) return effects.repair(item, message);
      const fingerprint = partnerHash({ projectId, runId: item.runId, blocker: item.blocker, message: safe(message, 4000) });
      const duplicate = await withClient(async c => Boolean((await c.query(`select 1 from artifacts where run_id=$1::uuid and kind='queue_partner_operator_instruction' and content->>'fingerprint'=$2 limit 1`, [item.runId, fingerprint])).rowCount));
      if (!duplicate) await recordRunAction({ runId: item.runId, agentId: "workflow-orchestrator", actionType: "queue_partner_operator_repair_requested", target: item.runId,
        summary: "Authenticated operator requested repair through the existing Partner owner; no copied claim, generic clone, terminal reset or approval widening.", artifactKind: "queue_partner_operator_instruction",
        artifactContent: { version: 1, projectId, runId: item.runId, instruction: safe(message, 4000), fingerprint, channel: "authenticated-local-dashboard", action: "repair", status: "requested", guardsUnchanged: true }, idempotencyKey: `repair-request-${fingerprint}` });
      return { status: "requested", runId: item.runId, text: `Repair requested for ${item.title}. The existing coordinator retains this family; no duplicate attempt was created. Current blocker: ${item.blocker || "Fresh evidence review is required."}` };
    },
    approve: effects.approve,
    stop: effects.stop,
    converse: effects.converse,
  };
  return adapter;
}
