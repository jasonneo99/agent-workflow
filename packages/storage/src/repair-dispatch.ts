import { acceptanceDigest, storedAcceptanceDecision } from "./acceptance.js";
import { workflowAcceptanceTask } from "../../model-providers/src/quality.js";
import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { partnerManagesRepairOnClient } from './queue-repair-management.js';

export function repairFingerprint(task: string, failure: string): string {
  const normalize = (value: string) => value.toLowerCase()
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gu, "<run>")
    .replace(/\s+/gu, " ").trim();
  return acceptanceDigest({ task: normalize(workflowAcceptanceTask(task)), failure: normalize(failure) });
}

export function repairEvidenceChanged(previous: string[] | null, current: string[]): boolean {
  return previous === null || current.some((id) => !previous.includes(id));
}

/** Validation claims qualify only after their exact governed checks resolve. */
export async function validatedRepairEvidence(
  client: Parameters<typeof storedAcceptanceDecision>[0], runId: string
): Promise<string[]> {
  const candidates = await client.query<{ id: string; content: Record<string, unknown> }>(
    `select id::text,content from artifacts where run_id=$1 and kind='direct_repair_validation' order by id`, [runId]);
  const ids: string[] = [];
  for (const candidate of candidates.rows) {
    const decision = await storedAcceptanceDecision(client, runId, "verification", candidate.content);
    if (decision.mode === "structured" && decision.reason === null) {
      const contract = candidate.content.acceptanceContract as import("../../model-providers/src/types.js").StructuredAcceptanceContract;
      // A copied report is not changed evidence. Bind rearming to the exact
      // resolved checks, independent of report IDs and receipt array order.
      const checks = contract.deliverables.flatMap((item) => item.receipts.verification ?? [])
        .map((reference) => acceptanceDigest(reference));
      const identity = acceptanceDigest([...new Set(checks)].sort());
      if (!ids.includes(identity)) ids.push(identity);
    }
  }
  return ids;
}


export type RepairCoordinatorClaim = { id: string; fence: string };

/** Caller holds the shared coordinator scheduler lock for this decision. */
export async function coordinatorAllowsRepair(
  client: Parameters<typeof storedAcceptanceDecision>[0],
  input: { runId: string; projectId: string; runSetId: string; coordinatorClaim?: RepairCoordinatorClaim }
): Promise<boolean> {
  // Partner management is durable even between assignments and while paused.
  // No exact live fenced coordinator claim means no competing legacy repair.
  if (!input.coordinatorClaim && await partnerManagesRepairOnClient(client,input.projectId,`${input.projectId}:${input.runSetId}`)) return false;
  const available = Boolean((await client.query("select to_regclass('queue_coordinator_assignments') name")).rows[0]?.name);
  if (!available) return input.coordinatorClaim === undefined;
  const assignments = await client.query<{ id: string; fence: string; sourceRunId: string; live: boolean }>(
    `select a.id::text,a.fence::text,a.source_run_id::text as "sourceRunId",
      (a.state in ('reserved','running') and exists(select 1 from work_intents i
        where i.project_id::text=a.project_id::text and i.owner=a.owner
          and i.fencing_token::text=a.intent_fence and i.expires_at>now())) as live
     from queue_coordinator_assignments a where a.project_id=$1 and a.family_id=$2
       and a.state in ('reserved','running','uncertain') for update of a`,
    [input.projectId, `${input.projectId}:${input.runSetId}`]);
  if (!assignments.rows.length) return input.coordinatorClaim === undefined;
  return assignments.rows.length === 1 && assignments.rows[0].live === true
    && assignments.rows[0].sourceRunId === input.runId
    && assignments.rows[0].id === input.coordinatorClaim?.id
    && assignments.rows[0].fence === input.coordinatorClaim?.fence;
}

/** A durable reservation intentionally fails closed if dispatch crashes afterward. */
export async function reserveSupervisedRepair(input: { runId: string; task: string; failure: string; coordinatorClaim?: RepairCoordinatorClaim }): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      // Same ordering as coordinator reservations prevents cross-producer races.
      await client.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
      const run = await client.query<{ projectId: string; runSetId: string; task: string; metadata: Record<string, unknown> }>("select project_id::text as \"projectId\", run_set_id::text as \"runSetId\", task, evaluation_metadata as metadata from workflow_runs where id=$1 for update", [input.runId]);
      const projectId = run.rows[0]?.projectId;
      if (!projectId) throw new Error("Repair source project is unavailable.");
      const source = run.rows[0];
      if (!await coordinatorAllowsRepair(client, { runId: input.runId, projectId, runSetId: source.runSetId, coordinatorClaim: input.coordinatorClaim })) {
        await client.query("rollback");
        return false;
      }
      const repairSources = new Set(["blocked-run-repair", "workflow-supervisor-repair", "workflow-root-repair"]);
      if (source.task !== input.task || repairSources.has(String(source.metadata?.source ?? ""))
        || source.metadata?.sourceRunId || source.metadata?.replayOfRunId) {
        await client.query("rollback");
        return false;
      }
      // Serialize every diagnosis for this source; changing a fingerprint cannot reset the budget.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`repair-source:${projectId}:${input.runId}`]);
      const budget = await client.query<{ attempts: number; coolingDown: boolean }>(
        `select count(*)::int as attempts,
          coalesce(max(created_at) + (least(3600, 60 * power(2, greatest(count(*) - 1, 0))) * interval '1 second') > now(), false) as "coolingDown"
         from artifacts where run_id=$1 and kind='repair_dispatch_claim'`, [input.runId]);
      const attempts = budget.rows[0];
      if (!attempts || !Number.isInteger(attempts.attempts) || attempts.attempts < 0
        || attempts.attempts >= 3 || attempts.coolingDown !== false) {
        await client.query("rollback");
        return false;
      }
      const fingerprint = repairFingerprint(input.task, input.failure);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`repair:${projectId}:${fingerprint}`]);
      const previous = await client.query<{ evidenceIds: string[] }>(
        `select a.content->'evidenceIds' as "evidenceIds" from artifacts a
         join workflow_runs r on r.id=a.run_id where r.project_id=$1
         and a.kind='repair_dispatch_claim' and a.content->>'fingerprint'=$2
         order by a.created_at desc limit 1`, [projectId, fingerprint]);
      // Counter-only reports and historical receipts cannot rearm dispatch.
      const evidenceIds = await validatedRepairEvidence(client, input.runId);
      const allowed = repairEvidenceChanged(previous.rows[0]?.evidenceIds ?? null, evidenceIds);
      const idempotencyKey = `repair-${allowed ? "claim" : "suppression"}:${fingerprint}:${acceptanceDigest(evidenceIds)}`;
      const artifactKind = allowed ? "repair_dispatch_claim" : "repair_dispatch_suppression";
      const artifactUri = `db://workflow_runs/${input.runId}/${artifactKind}/${idempotencyKey}`;
      const artifactContent = { fingerprint, evidenceIds, allowed, idempotencyKey };
      await appendActionReceipt(client, { runId: input.runId, agentId: "workflow-orchestrator",
        actionType: allowed ? "repair_dispatch_reserved" : "repair_dispatch_suppressed",
        target: fingerprint,
        summary: allowed ? "Reserved one repair attempt for this failure and validated evidence." : "Unchanged failure already attempted; a new validated fix is required before another repair.",
        metadata: JSON.stringify(artifactContent) });
      await client.query(
        `insert into artifacts(run_id,kind,uri,content) values ($1,$2,$3,$4::jsonb)
         on conflict (uri) do nothing`,
        [input.runId, artifactKind, artifactUri, JSON.stringify(artifactContent)]);
      await client.query("commit");
      return allowed;
    } catch (error) { await client.query("rollback"); throw error; }
  });
}
