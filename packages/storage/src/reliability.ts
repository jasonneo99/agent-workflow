import { randomUUID } from "node:crypto";
import { objectiveHash, workIntentsConflict, type WorkIntent } from "../../reliability-control/src/index.js";
import { withClient } from "./client.js";

export async function acquireWorkIntent(input: { projectId: string; owner: string; objective: string; fileScopes?: string[]; ttlSeconds?: number }): Promise<WorkIntent> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [input.projectId]);
      const active = await client.query<WorkIntent>(`select project_id as "projectId", owner, objective_hash as "objectiveHash", file_scopes as "fileScopes", expires_at::text as "expiresAt", fencing_token::text as "fencingToken" from work_intents where project_id=$1 and expires_at>now()`, [input.projectId]);
      const candidate = { owner: input.owner, objectiveHash: objectiveHash(input.objective), fileScopes: input.fileScopes ?? [] };
      const conflict = active.rows.find((intent) => workIntentsConflict(candidate, intent));
      if (conflict) throw new Error(`Work intent conflicts with active owner ${conflict.owner}.`);
      const ttl = Math.max(30, Math.min(3600, input.ttlSeconds ?? 900));
      const result = await client.query<WorkIntent>(`insert into work_intents (id,project_id,owner,objective_hash,file_scopes,expires_at,fencing_token,updated_at) values ($1,$2,$3,$4,$5,now()+($6::int*interval '1 second'),1,now()) on conflict(project_id,owner) do update set objective_hash=excluded.objective_hash,file_scopes=excluded.file_scopes,expires_at=excluded.expires_at,fencing_token=work_intents.fencing_token+1,updated_at=now() returning project_id as "projectId",owner,objective_hash as "objectiveHash",file_scopes as "fileScopes",expires_at::text as "expiresAt",fencing_token::text as "fencingToken"`, [randomUUID(), input.projectId, input.owner, candidate.objectiveHash, JSON.stringify(candidate.fileScopes), ttl]);
      await client.query("commit"); return result.rows[0];
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function renewWorkIntent(input: { projectId: string; owner: string; fencingToken: string; ttlSeconds?: number }): Promise<boolean> {
  const ttl = Math.max(30, Math.min(3600, input.ttlSeconds ?? 900));
  return withClient(async (client) => (await client.query(`update work_intents set expires_at=now()+($4::int*interval '1 second'),updated_at=now() where project_id=$1 and owner=$2 and fencing_token=$3::bigint and expires_at>now()`, [input.projectId,input.owner,input.fencingToken,ttl])).rowCount === 1);
}

export async function releaseWorkIntent(input: { projectId: string; owner: string; fencingToken: string }): Promise<boolean> {
  return withClient(async (client) => (await client.query(`delete from work_intents where project_id=$1 and owner=$2 and fencing_token=$3::bigint`, [input.projectId,input.owner,input.fencingToken])).rowCount === 1);
}

export async function listWorkIntents(projectId?: string): Promise<WorkIntent[]> {
  return withClient(async (client) => (await client.query<WorkIntent>(`select project_id as "projectId",owner,objective_hash as "objectiveHash",file_scopes as "fileScopes",expires_at::text as "expiresAt",fencing_token::text as "fencingToken" from work_intents where expires_at>now() and ($1::text is null or project_id=$1) order by updated_at desc`, [projectId ?? null])).rows);
}

export async function recordSideEffectOnce(input: { projectId: string; idempotencyKey: string; operation: string; target: string; receipt: Record<string, unknown> }): Promise<{ reused: boolean; receipt: Record<string, unknown> }> {
  return withClient(async (client) => {
    const inserted = await client.query<{ receipt: Record<string, unknown> }>(`insert into side_effect_receipts(project_id,idempotency_key,operation,target,receipt) values($1,$2,$3,$4,$5) on conflict(project_id,idempotency_key) do nothing returning receipt`, [input.projectId,input.idempotencyKey,input.operation,input.target,JSON.stringify(input.receipt)]);
    if (inserted.rows[0]) return { reused: false, receipt: inserted.rows[0].receipt };
    const existing = await client.query<{ receipt: Record<string, unknown> }>(`select receipt from side_effect_receipts where project_id=$1 and idempotency_key=$2`,[input.projectId,input.idempotencyKey]);
    return { reused: true, receipt: existing.rows[0]?.receipt ?? {} };
  });
}
