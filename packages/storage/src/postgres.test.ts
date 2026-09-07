import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("storage SQL does not reuse one parameter with conflicting casts", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const queryPattern = /client\.query(?:<[^>]+>)?\(\s*`([\s\S]*?)`/gu;
  const failures: string[] = [];

  for (const match of source.matchAll(queryPattern)) {
    const sql = match[1];
    const parameterNumbers = new Set([...sql.matchAll(/\$(\d+)/gu)].map((item) => item[1]));
    for (const parameterNumber of parameterNumbers) {
      const casts = new Set(
        [...sql.matchAll(new RegExp(`\\$${parameterNumber}::([a-zA-Z_][a-zA-Z0-9_\\[\\]]*)`, "gu"))]
          .map((item) => item[1])
      );
      if (casts.size > 1) {
        failures.push(`$${parameterNumber} is cast as ${[...casts].join(", ")} in ${compactSql(sql)}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("queue action receipt inserts use separate uuid and text parameters", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /values \(\$1::uuid, 'workflow-orchestrator', 'expired_worker_lease_requeued', \$2::text, \$3, \$4\)/u
  );
  assert.match(
    source,
    /values \(\$1::uuid, 'workflow-orchestrator', 'checkpoint_resume_requested', \$2::text, \$3, \$4\)/u
  );
  assert.match(
    source,
    /values \(\$1::uuid, 'workflow-orchestrator', 'failed_run_dismissed', \$2::text, \$3, \$4\)/u
  );
});

test("completed retried tasks can finalize runs with cancelled downstream tasks", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /set status = 'completed'[\s\S]+not exists \([\s\S]+wt\.status in \('queued', 'running', 'failed'\)/u
  );
});

test("stale terminal run reconciliation only repairs terminal child-task runs", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /export async function listStaleTerminalWorkflowRuns[\s\S]+wr\.status in \('queued', 'running'\)[\s\S]+having count\(\*\) > 0[\s\S]+wt\.status in \('queued', 'running', 'failed'\)\) = 0/u
  );
  assert.match(
    source,
    /export async function reconcileStaleTerminalWorkflowRuns[\s\S]+active\.status in \('queued', 'running', 'failed'\)[\s\S]+'stale_run_reconciled'/u
  );
});

function compactSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ").slice(0, 220);
}
