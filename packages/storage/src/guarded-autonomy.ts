import { createHash, randomUUID } from "node:crypto";
import {
  advanceTransaction,
  authorizeGuardedAction,
  breakerStateSchema,
  evaluatePromotionEvidence,
  evaluateCanaryOutcome,
  memoryClaimSchema,
  stageAuthorityGrantSchema,
  transactionReceiptSchema,
  type BreakerState,
  type StageAuthorityGrant
} from "../../guarded-autonomy/src/index.js";
import { withClient } from "./client.js";

type BreakerScope = BreakerState["scope"];
type BreakerKey = { scope: BreakerScope; scopeId: string };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function listCurrentBreakers(keys: BreakerKey[]): Promise<BreakerState[]> {
  if (!keys.length) return [];
  return withClient(async (client) => {
    await client.query("begin");
    try {
      for (const key of keys) {
        await client.query(
          `insert into breaker_events(scope,scope_id,generation,state,reason,actor,human_authored)
           values($1,$2,1,'enabled','Initial fail-closed breaker generation.','system',true)
           on conflict(scope,scope_id,generation) do nothing`,
          [key.scope, key.scopeId]
        );
      }
      const result = await client.query<{
        scope: BreakerScope; scopeId: string; generation: string; state: BreakerState["state"];
        reason: string; actor: string; createdAt: string; humanAuthored: boolean; evidenceHashes: string[];
      }>(
        `select distinct on (scope,scope_id) scope,scope_id as "scopeId",generation::text,state,reason,actor,
           created_at::text as "createdAt",human_authored as "humanAuthored",evidence_hashes as "evidenceHashes"
         from breaker_events
         where (scope,scope_id) in (select * from unnest($1::text[],$2::text[]))
         order by scope,scope_id,generation desc`,
        [keys.map((item) => item.scope), keys.map((item) => item.scopeId)]
      );
      await client.query("commit");
      return result.rows.map((row) => breakerStateSchema.parse({
        schema_version: 1,
        scope: row.scope,
        scope_id: row.scopeId,
        generation: Number(row.generation),
        state: row.state,
        reason: row.reason,
        actor: row.actor,
        created_at: row.createdAt,
        human_authored: row.humanAuthored,
        evidence_hashes: row.evidenceHashes ?? []
      }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function issueStageAuthorityGrant(input: {
  projectId: string; runId: string; stageId: string; workflowId: string; agentId: string; providerId: string;
  policySnapshot: unknown; evidence: string; expiresAt: string; mutationAllowed: boolean;
}): Promise<StageAuthorityGrant> {
  const keys: BreakerKey[] = [
    { scope: "global", scopeId: "all" }, { scope: "project", scopeId: input.projectId },
    { scope: "workflow", scopeId: input.workflowId }, { scope: "agent", scopeId: input.agentId },
    { scope: "provider", scopeId: input.providerId }, { scope: "tool_class", scopeId: "local-actions" }
  ];
  const breakers = await listCurrentBreakers(keys);
  const grant = stageAuthorityGrantSchema.parse({
    schema_version: 1,
    id: `grant-${input.runId}-${input.stageId}-${randomUUID()}`,
    project_id: input.projectId,
    run_id: input.runId,
    stage_id: input.stageId,
    requested_level: input.mutationAllowed ? "bounded_local" : "observe",
    policy_ceiling: input.mutationAllowed ? "bounded_local" : "observe",
    issued_level: input.mutationAllowed ? "bounded_local" : "observe",
    effect_class: input.mutationAllowed ? "R1" : "R0",
    evidence_hashes: [sha256(input.evidence)],
    policy_hash: sha256(JSON.stringify(input.policySnapshot)),
    breaker_generations: Object.fromEntries(breakers.map((item) => [`${item.scope}:${item.scope_id}`, item.generation])),
    issued_by: "policy-engine",
    issued_at: new Date().toISOString(),
    expires_at: input.expiresAt,
    preview_only: !input.mutationAllowed
  });
  await withClient((client) => client.query(
    `insert into authority_grants(id,project_id,run_id,stage_id,grant_payload) values($1,$2,$3,$4,$5::jsonb) on conflict(id) do nothing`,
    [grant.id, input.projectId, input.runId, input.stageId, JSON.stringify(grant)]
  ).then(() => undefined));
  return grant;
}

export async function assertStageAuthority(input: { grant: StageAuthorityGrant; mutation: boolean }): Promise<void> {
  const keys = Object.keys(input.grant.breaker_generations).map((key) => {
    const separator = key.indexOf(":");
    return { scope: key.slice(0, separator) as BreakerScope, scopeId: key.slice(separator + 1) };
  });
  let breakers: BreakerState[] | null = null;
  try { breakers = await listCurrentBreakers(keys); } catch { breakers = null; }
  const decision = authorizeGuardedAction({ grant: input.grant, currentBreakers: breakers, now: new Date().toISOString(), mutation: input.mutation });
  if (!decision.allowed) throw new Error(`Stage authority denied: ${decision.reasons.join("; ")}`);
}

export async function tripBreaker(input: {
  scope: BreakerScope; scopeId: string; state: "tripped" | "observe_only" | "enabled";
  reason: string; actor: string; humanAuthored: boolean; evidenceHashes?: string[];
}): Promise<BreakerState> {
  if (input.state === "enabled" && !input.humanAuthored) throw new Error("Breaker re-enable must be human-authored.");
  return withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`breaker:${input.scope}:${input.scopeId}`]);
      const result = await client.query<{ generation: string; createdAt: string }>(
        `insert into breaker_events(scope,scope_id,generation,state,reason,actor,human_authored,evidence_hashes)
         values($1,$2,coalesce((select max(generation)+1 from breaker_events where scope=$1 and scope_id=$2),1),$3,$4,$5,$6,$7::jsonb)
         returning generation::text,created_at::text as "createdAt"`,
        [input.scope, input.scopeId, input.state, input.reason, input.actor, input.humanAuthored, JSON.stringify(input.evidenceHashes ?? [])]
      );
      if (input.state !== "enabled") {
        const scopePredicate = input.scope === "global" ? "true"
          : input.scope === "project" ? "p.root_uri=$2"
          : input.scope === "workflow" ? "wr.workflow_id=$2"
          : input.scope === "agent" ? "wt.agent_id=$2"
          : input.scope === "provider" ? "coalesce(wr.provider_override,'')=$2"
          : "true";
        await client.query(
          `update workflow_tasks wt set status='queued',worker_id=null,lease_expires_at=null,lease_generation=lease_generation+1,available_at=now()
           from workflow_runs wr join projects p on p.id=wr.project_id
           where wt.run_id=wr.id and wt.status in ('leased','running') and ${scopePredicate}`,
          [input.scope, input.scopeId]
        );
      }
      await client.query("commit");
      return breakerStateSchema.parse({ schema_version: 1, scope: input.scope, scope_id: input.scopeId, generation: Number(result.rows[0].generation), state: input.state, reason: input.reason, actor: input.actor, created_at: result.rows[0].createdAt, human_authored: input.humanAuthored, evidence_hashes: input.evidenceHashes ?? [] });
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function appendProvenanceClaim(input: unknown): Promise<void> {
  const claim = memoryClaimSchema.parse(input);
  await withClient((client) => client.query(
    `insert into provenance_memory_claims(id,project_id,tenant_id,source_hash,claim,state,dependency_ids,conflict_ids)
     values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb)`,
    [claim.id, claim.project_id, claim.tenant_id, claim.source_hash, JSON.stringify(claim), claim.state, JSON.stringify(claim.dependency_ids), JSON.stringify(claim.conflict_ids)]
  ).then(() => undefined));
}

export async function revokeProvenanceSource(sourceHash: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query(`
      with recursive impacted(id,direct) as (
        select id,true from provenance_memory_claims where source_hash=$1
        union
        select child.id,false from provenance_memory_claims child join impacted parent on child.dependency_ids ? parent.id
      )
      update provenance_memory_claims claim
      set state=case when impacted.direct then 'revoked' else 'stale' end,
          claim=jsonb_set(claim.claim,'{state}',to_jsonb(case when impacted.direct then 'revoked' else 'stale' end::text))
      from impacted where claim.id=impacted.id and claim.state not in ('revoked','stale')
    `, [sourceHash]);
    return result.rowCount ?? 0;
  });
}

export async function persistGuardedTransaction(input: { projectId: string; receipt: unknown; expectedLeaseGeneration?: number; nextState?: string; verification?: "pending" | "passed" | "failed" }): Promise<void> {
  let receipt = transactionReceiptSchema.parse(input.receipt);
  if (input.nextState) receipt = advanceTransaction({ receipt, expectedLeaseGeneration: input.expectedLeaseGeneration ?? receipt.lease_generation, nextState: input.nextState as typeof receipt.state, verification: input.verification });
  await withClient((client) => client.query(
    `insert into guarded_transactions(transaction_id,project_id,receipt) values($1,$2,$3::jsonb)
     on conflict(transaction_id) do update set receipt=excluded.receipt,updated_at=now()`,
    [receipt.transaction_id, input.projectId, JSON.stringify(receipt)]
  ).then(() => undefined));
}

export async function queuePromotionCandidate(input: { projectId: string; baselineHash: string; candidate: unknown; evidence: unknown }): Promise<{ id: string; decision: ReturnType<typeof evaluatePromotionEvidence>["decision"] }> {
  const decision = evaluatePromotionEvidence(input.evidence);
  const status = decision.decision === "blocked" ? "quarantined" : "proposed";
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(`insert into promotion_candidates(project_id,baseline_hash,candidate,evidence,status) values($1,$2,$3::jsonb,$4::jsonb,$5) returning id::text`, [input.projectId, input.baselineHash, JSON.stringify(input.candidate), JSON.stringify(input.evidence), status]);
    await client.query(`insert into promotion_events(candidate_id,to_status,actor,reason,receipt) values($1,$2,'evaluator',$3,$4::jsonb)`, [result.rows[0].id, status, decision.reasons.join("; ") || decision.decision, JSON.stringify({ decision })]);
    return { id: result.rows[0].id, decision: decision.decision };
  });
}

export async function transitionPromotionCandidate(input: { id: string; to: "approved" | "canary" | "promoted" | "rolled_back" | "quarantined" | "rejected"; actor: string; reason: string; receipt?: unknown; humanAuthored?: boolean }): Promise<void> {
  if ((input.to === "approved" || input.to === "promoted") && !input.humanAuthored) throw new Error(`${input.to} requires a human-authored decision.`);
  await withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query<{ status: string }>(`select status from promotion_candidates where id=$1 for update`, [input.id]);
      if (!current.rows[0]) throw new Error(`Unknown promotion candidate: ${input.id}`);
      const allowed: Record<string, string[]> = { proposed: ["approved","rejected","quarantined"], approved: ["canary","rejected","quarantined"], canary: ["promoted","rolled_back","quarantined"], promoted: ["rolled_back","quarantined"], rolled_back: [], quarantined: [], rejected: [] };
      if (!allowed[current.rows[0].status]?.includes(input.to)) throw new Error(`Invalid promotion transition: ${current.rows[0].status} -> ${input.to}`);
      await client.query(`update promotion_candidates set status=$2,updated_at=now() where id=$1`, [input.id, input.to]);
      await client.query(`insert into promotion_events(candidate_id,from_status,to_status,actor,reason,receipt) values($1,$2,$3,$4,$5,$6::jsonb)`, [input.id, current.rows[0].status, input.to, input.actor, input.reason, JSON.stringify(input.receipt ?? {})]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function recordCanaryOutcome(input: { id: string; projectId: string; outcome: Parameters<typeof evaluateCanaryOutcome>[0]; actor: string }): Promise<ReturnType<typeof evaluateCanaryOutcome>> {
  const decision = evaluateCanaryOutcome(input.outcome);
  if (decision.action === "rollback_quarantine") {
    await transitionPromotionCandidate({ id: input.id, to: "rolled_back", actor: input.actor, reason: decision.reasons.join("; "), receipt: { quarantine: true, outcome: input.outcome } });
    await tripBreaker({ scope: "project", scopeId: input.projectId, state: "observe_only", reason: `Canary rollback: ${decision.reasons.join("; ")}`, actor: "canary-controller", humanAuthored: false, evidenceHashes: [sha256(JSON.stringify(input.outcome))] });
  }
  return decision;
}
