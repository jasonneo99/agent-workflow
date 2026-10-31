import type {Client} from 'pg';

export class PartnerManagedRunRecoveryError extends Error {
 constructor(operation:'replay'|'resume'|'dismiss'|'reinstate'|'supersede'){
  super(`Generic ${operation} is forbidden for Partner-managed coordinator work. Preserve its terminal history and exact project contract; inspect the existing coordinator assignment and use its explicitly authorized history-preserving assessment or verifier reconciliation API with fresh intent/claim fencing. Callback text and copied lease metadata grant no recovery authority.`);
  this.name='PartnerManagedRunRecoveryError';
 }
}

/** Generic lifecycle conveniences must not clone coordinator leases or widen a
 * managed child's frozen policy. Only the separate typed coordinator
 * reconciliation APIs can create a fresh fenced assessment/review. Callback
 * prose, actor names and copied metadata never constitute such authority.
 * Lookup is inhibiting only: it cannot grant execution or change any status.
 */
export async function assertGenericRunRecoveryAllowed(c:Pick<Client,'query'>,runId:string,operation:'replay'|'resume'|'dismiss'|'reinstate'|'supersede'):Promise<void>{
 const table=(await c.query("select to_regclass('queue_coordinator_assignments') is not null present")).rows[0]?.present;
 const assignment=table?`exists(select 1 from queue_coordinator_assignments q where q.child_run_id=l.id or q.source_run_id=l.id)`:'false';
 const protectedRun=(await c.query(`with recursive lineage as (
  select r.id,r.project_id,r.run_set_id,coalesce(r.evaluation_metadata,'{}'::jsonb) metadata
  from workflow_runs r where r.id=$1::uuid
  union
  select p.id,p.project_id,p.run_set_id,coalesce(p.evaluation_metadata,'{}'::jsonb)
  from lineage l join workflow_runs p on p.id::text in (
   l.metadata->>'replayOfRunId',l.metadata->>'sourceRunId',l.metadata->>'repairOriginRunId',l.metadata->>'parentRunId')
 ), bounded as materialized(select * from lineage limit 1001)
 select 1 from bounded l where ${assignment}
 or exists(select 1 from artifacts a join workflow_runs s on s.id=a.run_id
  where s.id=l.id and a.kind='queue_partner_repair_management'
   and a.content->>'manager'='queue-partner' and a.content->>'enabled'='true'
   and a.content->>'projectId'=l.project_id::text and a.content->>'sourceRunId'=l.id::text
   and a.content->>'familyId'=l.project_id::text||':'||l.run_set_id::text)
 or (select count(*) from bounded)>=1001 limit 1`,[runId])).rowCount;
 if(protectedRun)throw new PartnerManagedRunRecoveryError(operation);
}
