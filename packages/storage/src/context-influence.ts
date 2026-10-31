import type pg from "pg";
import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { influenceHash, type ContextInfluence } from "../../project-evidence/src/influence.js";

export async function appendPlanContextInfluence(client: pg.Client, input: { runId: string; text: string; influence?: unknown; artifactUri: string; replaySourceRunId?: string }): Promise<void> {
  if (!input.influence) return; // Legacy callers have no trustworthy attribution.
  const influence = input.influence as ContextInfluence;
  if (influence.schemaVersion !== 1 || influence.authority !== "none" || influence.contextHash !== influenceHash(input.text) || !Array.isArray(influence.references)) throw new Error("Invalid compiled context influence identity");
  const references = input.replaySourceRunId ? [...influence.references.map(ref => ({ ...ref, freshness: "historical" })), { kind: "prior_run", key: input.replaySourceRunId, includedHash: influence.contextHash, observedAt: influence.capturedAt, freshness: "historical", confidence: "recorded", target: { type: "run", value: input.replaySourceRunId } }] : influence.references;
  await appendActionReceipt(client, { runId: input.runId, agentId: "workflow-orchestrator", actionType: "context_influence", target: input.artifactUri,
    summary: "Context supplied to plan compilation; causal model reasoning is not asserted.", metadata: JSON.stringify({ ...influence, references, phase: input.replaySourceRunId ? "replayed_plan" : "plan", ...(input.replaySourceRunId ? { replayOfRunId: input.replaySourceRunId } : {}), compiledBriefUri: input.artifactUri }) });
}

export async function readContextInfluence(projectRoot: string, runId: string) {
  return withClient(async client => {
    const result = await client.query<{ id: string; receiptHash: string; observedAt: string; phase: string; metadata: Record<string, unknown> }>(
      `select r.id::text,r.receipt_hash as "receiptHash",r.created_at::text as "observedAt",r.metadata->>'phase' as phase,r.metadata
       from action_receipts r join workflow_runs w on w.id=r.run_id join projects p on p.id=w.project_id
       where p.root_uri=$1 and w.id=$2::uuid and r.action_type in ('context_influence','context_influence_result')
       order by r.created_at,r.id limit 201`, [projectRoot,runId]);
    return { schemaVersion: 1, project: projectRoot, runId, authority: "none", meaning: "context-supplied-not-proof-of-causal-reasoning", status: result.rows.length ? "available" : "not_recorded", truncated: result.rows.length > 200, receipts: result.rows.slice(0,200) };
  });
}
