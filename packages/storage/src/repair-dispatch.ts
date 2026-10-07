import { acceptanceDigest, storedAcceptanceDecision } from "./acceptance.js";
import { workflowAcceptanceTask } from "../../model-providers/src/quality.js";
import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";

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


/** A durable reservation intentionally fails closed if dispatch crashes afterward. */
export async function reserveSupervisedRepair(input: { runId: string; task: string; failure: string }): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const run = await client.query<{ projectId: string }>("select project_id::text as \"projectId\" from workflow_runs where id=$1", [input.runId]);
      const projectId = run.rows[0]?.projectId;
      if (!projectId) throw new Error("Repair source project is unavailable.");
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
