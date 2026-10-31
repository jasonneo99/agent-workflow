import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { withClient } from "./client.js";

export type LocationKind = "canonical" | "checkout" | "worktree" | "vendor" | "historical";
export const projectIdentitySchemaSql = `
CREATE TABLE IF NOT EXISTS project_identities (
  id uuid PRIMARY KEY REFERENCES projects(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_identity_locations (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  identity_id uuid NOT NULL REFERENCES project_identities(id),
  kind text NOT NULL CHECK(kind IN ('canonical','checkout','worktree','vendor','historical')),
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0)
);
ALTER TABLE project_identity_locations ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS project_identity_locations_identity_idx ON project_identity_locations(identity_id);
CREATE TABLE IF NOT EXISTS project_identity_events (
  sequence bigint PRIMARY KEY, id uuid NOT NULL UNIQUE, created_at text NOT NULL,
  action text NOT NULL, actor text NOT NULL, reason text NOT NULL,
  changes jsonb NOT NULL, previous_hash text, event_hash text NOT NULL UNIQUE
);`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a<b ? -1 : a>b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export async function projectIdentitySchemaAvailable(client: Client): Promise<boolean> {
  return Boolean((await client.query("select to_regclass('project_identity_locations') as name")).rows[0]?.name);
}

/** Retain the original registration as the execution/permission scope. */
export async function registerProjectIdentityScope(client: Client, projectId: string, commonRoot?:string): Promise<void> {
  if (!await projectIdentitySchemaAvailable(client)) return; // Compatible with an unreloaded runtime/database.
  await client.query("insert into project_identities(id) values($1) on conflict do nothing", [projectId]);
  const added=await client.query(`insert into project_identity_locations(project_id,identity_id,kind)
    select id,id,case when root_uri ~* '(^|/)(vendor|node_modules)(/|$)' then 'vendor' else 'canonical' end
    from projects where id=$1 on conflict do nothing returning project_id`, [projectId]);
  if (!added.rowCount || !commonRoot) return;
  const main=(await client.query(`select p.id,l.identity_id from projects p join project_identity_locations l on l.project_id=p.id
    where p.root_uri=$1 and l.kind in ('canonical','checkout') for update of p,l`,[commonRoot])).rows[0];
  if (!main || main.id===projectId) return;
  await client.query("update project_identity_locations set identity_id=$2,kind='worktree',generation=generation+1 where project_id=$1 and kind='canonical'",[projectId,main.identity_id]);
  await appendIdentityEvent(client,"register_worktree","registration","Local Git common-directory relationship; original execution scope retained",{
    projectId,identityId:main.identity_id,commonRoot,permissionInheritance:false});
}

/** Explicit, additive registry initialization; never called by discovery reads. */
export async function initializeProjectIdentities(actor="operator",reason="Initialize additive identity metadata; no execution scopes changed"): Promise<void> {
  await transaction(async client => {
    await client.query(projectIdentitySchemaSql);
    await client.query("insert into project_identities(id) select id from projects on conflict do nothing");
    await client.query(`insert into project_identity_locations(project_id,identity_id,kind)
      select id,id,case when root_uri ~* '(^|/)(vendor|node_modules)(/|$)' then 'vendor' else 'canonical' end from projects on conflict do nothing`);
    await appendIdentityEvent(client,"initialize",actor,reason,{permissionInheritance:false});
  });
}

export interface IdentityAttachment { projectId: string; kind: Exclude<LocationKind, "canonical"> }
interface Binding { projectId: string; identityId: string; kind: LocationKind; generation:number }
interface Scope extends Binding { rootUri: string; policyDigest: string }
export interface ProjectIdentityPlan {
  version: 1; canonicalProjectId: string; attachments: IdentityAttachment[];
  scopes: Scope[]; digest: string;
}

export async function previewProjectIdentityPlanOnClient(client: Client, canonicalProjectId: string, attachments: IdentityAttachment[]): Promise<ProjectIdentityPlan> {
  if (typeof canonicalProjectId!=="string" || !Array.isArray(attachments)) throw new Error("Invalid explicit project identity plan.");
  canonicalProjectId=canonicalProjectId.toLowerCase();
  attachments=attachments.map(a=>({...a,projectId:typeof a?.projectId==="string" ? a.projectId.toLowerCase() : ""}));
  if (!uuid.test(canonicalProjectId) || !attachments.length || attachments.length > 100
    || attachments.some(a => !uuid.test(a.projectId) || a.projectId === canonicalProjectId
      || !["checkout","worktree","vendor","historical"].includes(a.kind))
    || new Set(attachments.map(a => a.projectId)).size !== attachments.length) throw new Error("Invalid explicit project identity attachment list.");
  const ordered = [...attachments].sort((a,b) => a.projectId.localeCompare(b.projectId));
  const ids = [canonicalProjectId, ...ordered.map(a => a.projectId)].sort();
  const rows = await client.query<{projectId:string;identityId:string;kind:LocationKind;generation:number;rootUri:string;config:unknown;profile:string}>(
    `select p.id::text as "projectId", l.identity_id::text as "identityId", l.kind,l.generation,
      p.root_uri as "rootUri",p.config,p.profile from projects p
      join project_identity_locations l on l.project_id=p.id where p.id=any($1::uuid[]) order by p.id`, [ids]);
  if (rows.rows.length !== ids.length) throw new Error("Every project location must already be registered and initialized.");
  const target = rows.rows.find(r => r.projectId === canonicalProjectId)!;
  if (target.kind !== "canonical" || target.identityId !== canonicalProjectId) throw new Error("Target must be an independent canonical identity, not another alias.");
  if (target.rootUri.split(/[\\/]/u).some(s=>["vendor","node_modules"].includes(s.toLowerCase()))) throw new Error("A dependency mirror cannot own the logical project.");
  for (const attachment of ordered) {
    const source=rows.rows.find(r=>r.projectId===attachment.projectId)!;
    if (source.rootUri.split(/[\\/]/u).some(s=>["vendor","node_modules"].includes(s.toLowerCase())) && attachment.kind!=="vendor") throw new Error("Pinned dependency locations must remain vendor/read-only.");
  }
  for (const source of rows.rows.filter(r => r.projectId !== canonicalProjectId)) {
    if (![source.projectId, canonicalProjectId].includes(source.identityId)) throw new Error("Location already belongs to a different identity; revert its reviewed link first.");
    const children = await client.query("select project_id from project_identity_locations where identity_id=$1 and project_id<>$1 limit 1", [source.projectId]);
    if (children.rows.length) throw new Error("Source has attached locations; reconcile its entire component explicitly first.");
  }
  const scopes = rows.rows.map(r => ({projectId:r.projectId,identityId:r.identityId,kind:r.kind,generation:r.generation,rootUri:r.rootUri,policyDigest:digest({config:r.config,profile:r.profile})}));
  const body = {version:1 as const,canonicalProjectId,attachments:ordered,scopes};
  return {...body,digest:digest(body)};
}

async function appendIdentityEvent(client: Client, action: string, actor: string, reason: string, changes: unknown): Promise<string> {
  if (!actor.trim() || !reason.trim()) throw new Error("An operator and reconciliation reason are required.");
  await client.query("select pg_advisory_xact_lock(hashtext('project-identity-audit'))");
  if (!await verifyProjectIdentityEventsOnClient(client)) throw new Error("Project identity audit chain is invalid.");
  const last = (await client.query("select sequence::text,event_hash from project_identity_events order by sequence desc limit 1")).rows[0];
  const record = {sequence:Number(last?.sequence ?? 0)+1,id:randomUUID(),createdAt:new Date().toISOString(),action,actor,reason,changes,previousHash:last?.event_hash ?? null};
  await client.query("insert into project_identity_events(sequence,id,created_at,action,actor,reason,changes,previous_hash,event_hash) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
    [record.sequence,record.id,record.createdAt,action,actor,reason,JSON.stringify(changes),record.previousHash,digest(record)]);
  return record.id;
}

/** Caller owns a transaction; updates links only, never projects/runs/policies. */
export async function applyProjectIdentityPlanOnClient(client: Client, plan: ProjectIdentityPlan, actor: string, reason: string): Promise<string> {
  const {digest:expected,...reviewed}=plan;
  if (reviewed.version!==1 || digest(reviewed)!==expected) throw new Error("Reviewed identity plan content changed; obtain a fresh plan.");
  const ids = [plan.canonicalProjectId,...plan.attachments.map(a => a.projectId)].sort();
  await client.query("select id from projects where id=any($1::uuid[]) order by id for update", [ids]);
  await client.query("select project_id from project_identity_locations where project_id=any($1::uuid[]) order by project_id for update", [ids]);
  const fresh = await previewProjectIdentityPlanOnClient(client,plan.canonicalProjectId,plan.attachments);
  if (fresh.digest !== plan.digest) throw new Error("Project registration or policy changed after preview; obtain a fresh plan.");
  const before = fresh.scopes.filter(s => s.projectId !== plan.canonicalProjectId).map(({projectId,identityId,kind,generation}) => ({projectId,identityId,kind,generation}));
  const after = fresh.attachments.map(a => ({projectId:a.projectId,identityId:plan.canonicalProjectId,kind:a.kind,generation:before.find(b=>b.projectId===a.projectId)!.generation+1}));
  for (const b of after) await client.query("update project_identity_locations set identity_id=$2,kind=$3,generation=$4 where project_id=$1",[b.projectId,b.identityId,b.kind,b.generation]);
  return appendIdentityEvent(client,"reconcile",actor,reason,{planDigest:fresh.digest,before,after,permissionInheritance:false});
}

export async function revertProjectIdentityEventOnClient(client: Client, eventId: string, actor: string, reason: string): Promise<string> {
  const event = (await client.query("select action,changes from project_identity_events where id=$1",[eventId])).rows[0];
  if (event?.action !== "reconcile") throw new Error("Only an existing reconciliation event can be reverted.");
  const {before,after} = event.changes as {before:Binding[];after:Binding[]};
  const current = await client.query<Binding>(`select project_id::text as "projectId",identity_id::text as "identityId",kind,generation from project_identity_locations where project_id=any($1::uuid[]) order by project_id for update`,[after.map(b => b.projectId)]);
  if (digest(current.rows) !== digest([...after].sort((a,b) => a.projectId.localeCompare(b.projectId)))) throw new Error("Identity links changed since reconciliation; refusing stale rollback.");
  const restored=before.map(b=>({...b,generation:after.find(a=>a.projectId===b.projectId)!.generation+1}));
  for (const b of restored) await client.query("update project_identity_locations set identity_id=$2,kind=$3,generation=$4 where project_id=$1",[b.projectId,b.identityId,b.kind,b.generation]);
  return appendIdentityEvent(client,"revert",actor,reason,{reverts:eventId,before:after,after:restored,permissionInheritance:false});
}

async function transaction<T>(body: (client:Client) => Promise<T>): Promise<T> {
  return withClient(async client => {await client.query("begin");try {const result=await body(client);await client.query("commit");return result;} catch(error){await client.query("rollback");throw error;}});
}
export const previewProjectIdentityPlan = (id:string, attachments:IdentityAttachment[]) => withClient(c => previewProjectIdentityPlanOnClient(c,id,attachments));
export const applyProjectIdentityPlan = (plan:ProjectIdentityPlan,actor:string,reason:string) => transaction(c => applyProjectIdentityPlanOnClient(c,plan,actor,reason));
export const revertProjectIdentityEvent = (id:string,actor:string,reason:string) => transaction(c => revertProjectIdentityEventOnClient(c,id,actor,reason));

export async function listProjectIdentities() {
  return withClient(async client => (await client.query(`select i.id::text,p.name,p.root_uri as "rootUri",
    jsonb_agg(jsonb_build_object('scopeProjectId',s.id,'rootUri',s.root_uri,'kind',l.kind,'inheritsPermissions',false) order by s.root_uri) as locations
    from project_identities i join project_identity_locations own on own.project_id=i.id and own.identity_id=i.id and own.kind='canonical'
    join projects p on p.id=i.id join project_identity_locations l on l.identity_id=i.id join projects s on s.id=l.project_id
    group by i.id,p.name,p.root_uri order by p.name,p.root_uri`)).rows);
}

export async function verifyProjectIdentityEventsOnClient(client:Client): Promise<boolean> {
  const rows = (await client.query("select * from project_identity_events order by sequence")).rows;
  let previousHash:string|null=null; let sequence=0;
  for (const r of rows) {
    const body={sequence:Number(r.sequence),id:r.id,createdAt:r.created_at,action:r.action,actor:r.actor,reason:r.reason,changes:r.changes,previousHash:r.previous_hash};
    if (body.sequence !== ++sequence || body.previousHash !== previousHash || digest(body) !== r.event_hash) return false;
    previousHash=r.event_hash;
  }
  return true;
}

/** History projection only: execution scope and receipt/run IDs stay original. */
export async function listProjectIdentityRuns(identityId:string,limit=100) {
  if (!uuid.test(identityId) || !Number.isInteger(limit) || limit<1 || limit>500) throw new Error("Invalid identity history request.");
  return withClient(async c=>(await c.query(`select r.id::text,l.identity_id::text as "projectIdentityId",
    r.project_id::text as "executionScopeId",p.root_uri as "executionRootUri",r.status,r.workflow_id as "workflowId",
    r.run_set_id::text as "runSetId",r.evaluation_metadata->>'sourceRunId' as "sourceRunId",
    r.evaluation_metadata->>'replayOfRunId' as "replayOfRunId"
    from workflow_runs r join project_identity_locations l on l.project_id=r.project_id
    join projects p on p.id=r.project_id where l.identity_id=$1 order by r.started_at desc,r.id desc limit $2`,[identityId,limit])).rows);
}
