import { withClient } from "../../storage/src/client.js";

type Query = (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** Shared by manual and scheduled evaluate invocations; busy is not success. */
export async function withEvaluationSlot<T>(project: string, suite: string, run: () => Promise<T>, connect = withClient): Promise<{ skipped: boolean; value?: T }> {
  return connect(async (client) => evaluationSlot(client.query.bind(client) as Query, project, suite, run));
}

export async function evaluationSlot<T>(query: Query, project: string, suite: string, run: () => Promise<T>): Promise<{ skipped: boolean; value?: T }> {
  const key = JSON.stringify(["evaluation", project, suite]);
  const lock = await query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [key]);
  if (lock.rows[0]?.acquired !== true) return { skipped: true };
  try {
    const active = await query(`SELECT w.id FROM workflow_runs w JOIN projects p ON p.id=w.project_id
      WHERE p.root_uri=$1 AND w.evaluation_metadata->>'suiteId'=$2
      AND w.status NOT IN ('completed','failed','cancelled') LIMIT 1`, [project, suite]);
    if (active.rows.length) return { skipped: true };
    return { skipped: false, value: await run() };
  } finally {
    await query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
  }
}
