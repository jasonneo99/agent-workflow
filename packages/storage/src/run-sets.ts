export const workflowRunSetMigrationSql = `
  ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS run_set_id uuid DEFAULT gen_random_uuid();
  UPDATE workflow_runs SET run_set_id = gen_random_uuid() WHERE run_set_id IS NULL;
  DO $$
  DECLARE changed_rows integer := 1;
  DECLARE propagation_pass integer := 0;
  BEGIN
    WHILE changed_rows > 0 AND propagation_pass < 100 LOOP
      propagation_pass := propagation_pass + 1;
      UPDATE workflow_runs child
         SET run_set_id = source.run_set_id
        FROM workflow_runs source
       WHERE child.run_set_id IS DISTINCT FROM source.run_set_id
         AND (child.evaluation_metadata->>'sourceRunId' = source.id::text
           OR child.evaluation_metadata->>'replayOfRunId' = source.id::text);
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
    END LOOP;
  END $$;
  ALTER TABLE workflow_runs ALTER COLUMN run_set_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS workflow_runs_run_set_idx ON workflow_runs(run_set_id, started_at DESC);
`;

export const inheritedRunSetSql = `coalesce((
  select lineage.run_set_id
    from workflow_runs lineage
   where lineage.id::text in ($10::jsonb->>'sourceRunId', $10::jsonb->>'replayOfRunId')
   order by lineage.started_at desc
   limit 1
), gen_random_uuid())`;

export const queueRunSetRepresentativeSql = `wr.id = (
  select member.id
    from workflow_runs member
   where member.run_set_id = wr.run_set_id
     and not (member.status in ('failed', 'blocked') and member.evaluation_metadata ? 'suiteId')
     and not exists (
       select 1 from action_receipts hidden
        where hidden.run_id = member.id
          and hidden.action_type in ('failed_run_dismissed','failed_run_superseded')
          and not exists (
            select 1 from action_receipts reinstated
             where reinstated.run_id = member.id
               and reinstated.action_type = 'failed_run_reinstated'
               and reinstated.created_at > hidden.created_at
          )
     )
     and (member.status in ('queued', 'leased', 'running', 'failed', 'blocked') or exists (
       select 1 from workflow_tasks member_task
        where member_task.run_id = member.id and member_task.status in ('queued', 'leased', 'running', 'failed', 'blocked')
     ))
   order by case member.status when 'running' then 0 when 'leased' then 1 when 'queued' then 2 when 'blocked' then 3 when 'failed' then 4 else 5 end,
            member.started_at desc
   limit 1
)`;
