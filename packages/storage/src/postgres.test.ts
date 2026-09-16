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
    /set status = 'completed'[\s\S]+not exists \([\s\S]+wt\.status in \('queued', 'leased', 'running', 'failed', 'blocked'\)/u
  );
});

test("blocked stage output terminates the run without reporting success", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(source, /export async function blockWorkflowTask/u);
  assert.match(source, /update workflow_tasks set status = 'blocked'/u);
  assert.match(source, /export async function blockWorkflowTask[\s\S]+transitionWorkflowRun\(client, \{[\s\S]+to: "blocked"/u);
  assert.doesNotMatch(source, /update workflow_handoffs[\s\S]{0,200}note =/u);
  assert.match(source, /wt\.status in \('queued', 'leased', 'running', 'failed', 'blocked'\)/u);
});

test("checkpoint resume preserves terminal history by replaying into a new run", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /terminal === "failed" \|\| terminal === "blocked" \|\| terminal === "cancelled"/u);
  assert.match(source, /replayWorkflowRun\(\{ sourceRunId: input\.runId/u);
  assert.doesNotMatch(source, /update workflow_runs[\s\S]{0,120}set status = 'queued'/u);
});

test("stale terminal run reconciliation only repairs terminal child-task runs", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /export async function listStaleTerminalWorkflowRuns[\s\S]+wr\.status in \('queued', 'leased', 'running'\)[\s\S]+having count\(\*\) > 0[\s\S]+wt\.status in \('queued', 'leased', 'running', 'failed'\)\) = 0/u
  );
  assert.match(
    source,
    /export async function reconcileStaleTerminalWorkflowRuns[\s\S]+active\.status in \('queued', 'leased', 'running', 'failed'\)[\s\S]+'stale_run_reconciled'/u
  );
});

test("task leases use a distinct leased state and fenced terminal writes", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /acquireWorkflowRunLease[\s\S]+lease_epoch = lease_epoch \+ 1/u);
  assert.match(source, /update workflow_tasks set lease_generation = \$2::bigint/u);
  assert.match(source, /export async function startWorkflowTask[\s\S]+status='leased'[\s\S]+lease_generation=\$4::bigint/u);
  assert.match(source, /assertActiveTaskFence[\s\S]+wt\.status='running'[\s\S]+wt\.lease_generation=\$3::bigint[\s\S]+wr\.lease_epoch=\$3::bigint/u);
  assert.match(source, /export async function completeWorkflowTask[\s\S]+await assertActiveTaskFence\(client, input\)/u);
});

test("all run lifecycle writes route through the authoritative transition helper", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const directStatusWrites = [...source.matchAll(/update workflow_runs[\s\S]{0,140}?set status\s*=\s*['$]/gu)];
  assert.equal(directStatusWrites.length, 1, "only transitionWorkflowRun may perform runtime workflow_runs.status writes");
  assert.match(source, /workflow_run_transitions[\s\S]+UNIQUE\(run_id, idempotency_key\)[\s\S]+UNIQUE\(run_id, state_version\)/u);
  assert.match(source, /WHERE NOT EXISTS \([\s\S]+workflow_run_transitions existing WHERE existing\.run_id = wr\.id/u);
  assert.match(source, /assertWorkflowRunFence\(/u);
});

test("concurrent claims serialize run ownership and monotonically advance the fence", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /select status, lease_epoch::text as "leaseEpoch" from workflow_runs where id = \$1::uuid for update/u);
  assert.match(source, /lease_epoch = lease_epoch \+ 1/u);
  assert.match(source, /not exists \([\s\S]+active\.status in \('leased', 'running'\)/u);
  assert.match(source, /wr\.lease_owner=\$2 and wr\.lease_epoch=\$3::bigint/u);
});

function compactSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ").slice(0, 220);
}
