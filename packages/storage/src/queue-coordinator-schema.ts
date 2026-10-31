export const queueCoordinatorSchemaSql = `
create table if not exists queue_coordinator_assignments (
 id uuid primary key, fence bigserial unique, family_id text not null,
 project_id uuid not null references projects(id), source_run_id uuid not null references workflow_runs(id),
 role text not null check(role in ('repair','verifier')), lane integer not null,
 owner text not null, fingerprint text not null, intent_fence text not null,
 file_scopes jsonb not null, state text not null check(state in ('reserved','running','held','failed','verified','uncertain')),
 child_run_id uuid references workflow_runs(id), reason text not null default '',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((role='repair' and lane between 1 and 7) or (role='verifier' and lane=1)),
 unique(family_id,role,fingerprint)
);
alter table queue_coordinator_assignments add column if not exists legacy_enrollment_id uuid;
-- Replace only the exact known capacity constraint; unrelated constraints fail closed.
do $$ declare definition text; begin
 select pg_get_constraintdef(oid) into definition from pg_constraint
 where conrelid='queue_coordinator_assignments'::regclass and conname='queue_coordinator_assignments_check';
 if definition in ('CHECK ((((role = ''repair''::text) AND ((lane >= 1) AND (lane <= 3))) OR ((role = ''verifier''::text) AND (lane = 1))))',
                   'CHECK ((((role = ''repair''::text) AND ((lane >= 1) AND (lane <= 5))) OR ((role = ''verifier''::text) AND (lane = 1))))') then
  alter table queue_coordinator_assignments drop constraint queue_coordinator_assignments_check;
  alter table queue_coordinator_assignments add constraint queue_coordinator_assignments_check
   check((role='repair' and lane between 1 and 7) or (role='verifier' and lane=1));
 elsif definition is distinct from 'CHECK ((((role = ''repair''::text) AND ((lane >= 1) AND (lane <= 7))) OR ((role = ''verifier''::text) AND (lane = 1))))' then
  raise exception 'Unexpected coordinator capacity constraint; explicit review required';
 end if;
end $$;
create unique index if not exists queue_coordinator_active_family on queue_coordinator_assignments(family_id)
 where state in ('reserved','running','uncertain');
create unique index if not exists queue_coordinator_active_lane on queue_coordinator_assignments(role,lane)
 where state in ('reserved','running','uncertain');
create table if not exists queue_partner_outcome_journal (
 assignment_id uuid not null references queue_coordinator_assignments(id), fence bigint not null,
 project_id uuid not null references projects(id), source_run_id uuid not null references workflow_runs(id),
 child_run_id uuid references workflow_runs(id), state text not null check(state in ('held','failed','verified','uncertain')),
 reason text not null, payload jsonb not null, delivery_state text not null default 'pending' check(delivery_state in ('pending','delivered')),
 created_at timestamptz not null default clock_timestamp(), delivered_at timestamptz,
 primary key(assignment_id,fence)
);`;
