// Read-only queue membership. These predicates never change run state,
// acceptance, scheduling, or receipts and never grant execution. Explicit lineage is scoped to the registered project
// or its operator-reconciled logical identity; execution scopes never change.
function scopeSql(identity: boolean, projectRootParameter?: string): string {
  const scope = projectRootParameter
    ? identity
      ? `where (${projectRootParameter}::text is null or coalesce(l.identity_id,r.project_id)=(
          select coalesce(target_location.identity_id,target_project.id)
          from projects target_project
          left join project_identity_locations target_location on target_location.project_id=target_project.id
          where target_project.root_uri=${projectRootParameter} limit 1))`
      : `join projects scope_project on scope_project.id=r.project_id
        where (${projectRootParameter}::text is null or scope_project.root_uri=${projectRootParameter})`
    : "";
  return identity
    ? `family_runs as (select r.id,r.project_id,r.run_set_id,r.status,r.started_at,r.replacement_run_id,r.task,
        r.evaluation_metadata->>'suiteId' as suite_id,r.evaluation_metadata->>'source' as metadata_source,
        r.evaluation_metadata->>'actor' as metadata_actor,r.evaluation_metadata->>'actorRole' as metadata_actor_role,
        r.evaluation_metadata->>'idempotencyKey' as idempotency_key,r.evaluation_metadata->>'sourceRunId' as source_run_id,
        r.evaluation_metadata->>'replayOfRunId' as replay_of_run_id,r.evaluation_metadata->>'repairOriginRunId' as repair_origin_run_id,
        r.evaluation_metadata->>'parentRunId' as parent_run_id,
        coalesce(l.identity_id,r.project_id) as family_project_id
        from workflow_runs r left join project_identity_locations l on l.project_id=r.project_id ${scope})`
    : `family_runs as (select r.id,r.project_id,r.run_set_id,r.status,r.started_at,r.replacement_run_id,r.task,
        r.evaluation_metadata->>'suiteId' as suite_id,r.evaluation_metadata->>'source' as metadata_source,
        r.evaluation_metadata->>'actor' as metadata_actor,r.evaluation_metadata->>'actorRole' as metadata_actor_role,
        r.evaluation_metadata->>'idempotencyKey' as idempotency_key,r.evaluation_metadata->>'sourceRunId' as source_run_id,
        r.evaluation_metadata->>'replayOfRunId' as replay_of_run_id,r.evaluation_metadata->>'repairOriginRunId' as repair_origin_run_id,
        r.evaluation_metadata->>'parentRunId' as parent_run_id,
        r.project_id as family_project_id from workflow_runs r ${scope})`;
}

export function relatedRunIdsSql(seed: string, identity = false): string {
  return `${queuePresentationSql(identity)} select unnest(members) from queue_families where ${seed}=any(members)`;
}

function visible(alias: string): string {
  return `not (${alias}.status in ('failed','blocked') and ${alias}.evaluation_metadata ? 'suiteId')
    and not exists (select 1 from action_receipts hidden
      where hidden.run_id = ${alias}.id
        and (hidden.action_type in ('failed_run_dismissed','failed_run_superseded')
          or (hidden.action_type='obsolete_policy_contract_retired'
            and ${alias}.status in ('failed','blocked','cancelled')
            and hidden.metadata->>'authority'='direct-human'
            and hidden.metadata->>'disposition'='obsolete-policy-unaccepted'
            and hidden.metadata->>'viewOnly'='true'
            and hidden.metadata->>'originalAcceptanceChanged'='false'
            and hidden.metadata->>'runId'=${alias}.id::text
            and hidden.metadata->>'projectId'=${alias}.project_id::text
            and hidden.metadata->>'originalTask'=${alias}.task
            and not exists(select 1 from workflow_tasks active_task where active_task.run_id=${alias}.id and active_task.status in ('queued','leased','running'))
            and not exists(select 1 from action_approvals active_approval where active_approval.run_id=${alias}.id and active_approval.status in ('pending','approved','executing','failed'))
            and not exists(select 1 from queue_coordinator_assignments active_assignment
              where active_assignment.project_id=${alias}.project_id and (active_assignment.source_run_id=${alias}.id or active_assignment.child_run_id=${alias}.id)
                and active_assignment.state in ('reserved','running','uncertain'))
            and not exists(select 1 from side_effect_receipts active_effect where active_effect.project_id=${alias}.id::text
              and active_effect.status<>'completed' and not exists(select 1
                from jsonb_array_elements_text(coalesce(hidden.metadata->'reconciledEffectKeys','[]'::jsonb)) known_effect(key)
                where known_effect.key=active_effect.project_id||':'||active_effect.idempotency_key))
            and hidden.receipt_hash is not null
            and exists(select 1 from artifacts disposition
              where disposition.run_id=hidden.run_id and disposition.kind='obsolete_policy_disposition'
                and disposition.content=hidden.metadata)))
        and not exists (select 1 from action_receipts reinstated
          where reinstated.run_id = ${alias}.id
            and reinstated.action_type = 'failed_run_reinstated'
            and reinstated.created_at > hidden.created_at))`;
}

function unfinished(alias: string): string {
  // The run state is authoritative for queue membership. Terminal completed
  // and cancelled runs belong to history even if stale child rows or approval
  // records remain; those inconsistencies surface on their dedicated views.
  return `${alias}.status in ('queued','leased','running','blocked','failed')`;
}

// Also used as a NEGATIVE exact-source admission check. Never infer execution
// authority from display membership or from a different visible family member.
export function activeQueueRunPredicateSql(alias: string): string {
  return `${visible(alias)} and ${unfinished(alias)}`;
}

// Materialize the graph once per display query, not once per candidate card.
// Deduplicate identical component arrays before doing receipt/task lookups.
// Completed attempts remain in the family history, but the card itself is the
// newest visible unfinished attempt. A completed run never represents active
// queue work merely because an older family member still needs attention.
// UNION terminates cycles in malformed lineage.
export function queuePresentationSql(identity = false, projectRootParameter?: string): string { return `with recursive ${scopeSql(identity, projectRootParameter)}, explicit_sources as (
  -- Legacy operator requests froze a source list in the task rather than metadata.
  -- Only a single exact source UUID is a parent. A multi-item sweep must not fuse
  -- independent feature families; arbitrary task UUID mentions are not links.
  select r.id,r.family_project_id,array(select m[1] from regexp_matches(
    substring(left(r.task,2500) from 'Source items: ([^' || chr(10) || ']+)'),
    '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})','gi') m) as source_ids
  from family_runs r where r.metadata_source='server-orchestration'
    and r.metadata_actor_role='operator'
), set_members as (
  select id,first_value(id) over (partition by family_project_id,run_set_id order by id) as anchor
    from family_runs where run_set_id is not null
), forward_edges(a,b) as (
  select id,anchor from set_members where id<>anchor
  union
  select member.id,candidate.id from family_runs member
    join family_runs candidate on candidate.id=member.replacement_run_id
      and candidate.family_project_id = member.family_project_id
  union
  select member.id,candidate.id from explicit_sources member join family_runs candidate
    on cardinality(member.source_ids)=1 and candidate.id::text=member.source_ids[1]
      and candidate.family_project_id=member.family_project_id
  union
  select member.id,candidate.id from family_runs member join family_runs candidate
    on candidate.family_project_id=member.family_project_id and candidate.id<>member.id
      and length(member.idempotency_key)>=8
      and candidate.idempotency_key=member.idempotency_key
      and candidate.metadata_source=member.metadata_source
      and candidate.metadata_actor=member.metadata_actor
  union
  select member.id,candidate.id from family_runs member
    join family_runs candidate on candidate.id::text in (
      member.source_run_id,member.replay_of_run_id,member.repair_origin_run_id,member.parent_run_id)
      and candidate.family_project_id = member.family_project_id
), edges(a,b) as (
  select a,b from forward_edges union select b,a from forward_edges
), lineage(origin,id) as (
  select id,id from family_runs
  union
  select lineage.origin,edges.b from lineage join edges on edges.a=lineage.id
), families as (
  select distinct array_agg(id order by id) as members from lineage group by origin
), queue_families as (
  select members,cardinality(members) as related_count,
    (select coalesce(first_run.run_set_id,first_run.id) from workflow_runs first_run
      where first_run.id=any(members) order by first_run.started_at,first_run.id limit 1) as version_set_id,
    (select jsonb_agg(jsonb_build_object('id',attempt.id,'status',attempt.status,
      'blocker',(select left(coalesce(ar.metadata->>'reason',ar.summary),2000) from action_receipts ar
        where ar.run_id=attempt.id and ar.action_type in ('stage_blocked','stage_failed') order by ar.created_at desc limit 1),
      'approvals',(select coalesce(jsonb_agg(jsonb_build_object('id',aa.id,'status',aa.status)),'[]'::jsonb)
        from action_approvals aa where aa.run_id=attempt.id and aa.status in ('pending','failed','executing')))
      order by attempt.started_at desc,attempt.id desc) from workflow_runs attempt where attempt.id=any(members)) as attempts,
    (select latest.id from workflow_runs latest where latest.id=any(members)
       and ${activeQueueRunPredicateSql("latest")}
       order by latest.started_at desc,latest.id desc limit 1) as latest_id,
    (select count(*)::int from workflow_runs pending_run where pending_run.id=any(members)
       and ${activeQueueRunPredicateSql("pending_run")}) as open_count
  from families
)`; }

export const queuePresentationCteSql = queuePresentationSql();

export const relatedQueueCountsSql = `qf.related_count as "relatedRunCount",qf.version_set_id::text as "versionSetId",qf.attempts as "familyAttempts",
  (qf.open_count - case when ${unfinished("wr")} then 1 else 0 end) as "relatedOpenRunCount"`;
