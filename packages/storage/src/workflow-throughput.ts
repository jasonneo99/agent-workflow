import { withClient } from "./client.js";

export type WorkflowThroughputBucket = {
  key: string;
  completed: number;
  failed: number;
  active: number;
};

type WorkflowThroughputRow = {
  key: string;
  completed: string | number;
  failed: string | number;
  active: string | number;
};

export function normalizeWorkflowThroughputRows(rows: WorkflowThroughputRow[]): WorkflowThroughputBucket[] {
  return rows.map((row) => ({
    key: row.key,
    completed: Number(row.completed),
    failed: Number(row.failed),
    active: Number(row.active)
  }));
}

export async function listWorkflowRunThroughput(days = 7, timezone = "America/Los_Angeles"): Promise<WorkflowThroughputBucket[]> {
  const safeDays = Math.max(1, Math.min(Math.floor(days), 31));
  return withClient(async (client) => {
    const result = await client.query<WorkflowThroughputRow>(`
      with days as (
        select generate_series(
          (now() at time zone $1)::date - ($2::integer - 1),
          (now() at time zone $1)::date,
          interval '1 day'
        )::date as day
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as key,
        count(runs.id) filter (where runs.status = 'completed') as completed,
        count(runs.id) filter (where runs.status = 'failed') as failed,
        count(runs.id) filter (where runs.status not in ('completed', 'failed')) as active
      from days
      left join workflow_runs runs
        on (runs.started_at at time zone $1)::date = days.day
      group by days.day
      order by days.day
    `, [timezone, safeDays]);
    return normalizeWorkflowThroughputRows(result.rows);
  });
}
