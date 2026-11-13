/** Explicit installation only: ordinary task claims and existing audit rows are untouched.
 * Enforces the source claim predicate even for already-running older workers.
 * No SECURITY DEFINER, role grants, policy edits, service control or implicit installation.
 */
export const coordinatorClaimFenceSql=`
create or replace function agentflow_coordinator_claim_fence() returns trigger language plpgsql as $$
declare run_key uuid; project_key uuid; binding jsonb; worker text; valid boolean;
begin
 if TG_TABLE_NAME='workflow_runs' then
  -- Clearing an owner is recovery bookkeeping, never a claim.
  if NEW.lease_owner is null then return NEW; end if;
  run_key:=NEW.id;project_key:=NEW.project_id;binding:=NEW.evaluation_metadata;worker:=NEW.lease_owner;
 else
  if NEW.status not in ('leased','running') then return NEW; end if;
  run_key:=NEW.run_id;worker:=NEW.worker_id;
  execute format('select project_id,evaluation_metadata from %I.workflow_runs where id=$1',TG_TABLE_SCHEMA)
   into project_key,binding using run_key;
 end if;
 if not(coalesce(binding,'{}'::jsonb)?'queueCoordinatorClaimId') then return NEW; end if;
 execute format('select exists(select 1 from %I.queue_coordinator_assignments a join %I.work_intents i
   on i.project_id::text=a.project_id::text and i.owner=a.owner and i.fencing_token::text=a.intent_fence
   and i.expires_at>clock_timestamp()
   where a.id::text=$1 and a.child_run_id=$2 and a.project_id=$3
   and a.fence::text=$4 and a.state=''running'' and $5=a.owner||'':''||a.fence::text)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
  into valid using binding->>'queueCoordinatorClaimId',run_key,project_key,binding->>'queueCoordinatorFence',worker;
 if valid is not true then
  raise exception using errcode='55P03',message='Coordinator-owned work requires its exact live authorized worker and intent fence';
 end if;
 return NEW;
end $$;
drop trigger if exists agentflow_coordinator_run_claim on workflow_runs;
create trigger agentflow_coordinator_run_claim before insert or update of lease_owner,lease_epoch,lease_expires_at on workflow_runs
 for each row execute function agentflow_coordinator_claim_fence();
drop trigger if exists agentflow_coordinator_task_claim on workflow_tasks;
create trigger agentflow_coordinator_task_claim before insert or update of worker_id,status,lease_generation,lease_expires_at on workflow_tasks
 for each row execute function agentflow_coordinator_claim_fence();
`;
