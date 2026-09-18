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

test("successful direct actions dismiss stale approval cards for the same task and target", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const dismissal = source.slice(source.indexOf("export async function dismissSupersededActionApprovals"), source.indexOf("export async function decideActionApproval"));
  assert.match(dismissal, /status in \('pending', 'approved', 'failed'\)/u);
  assert.match(dismissal, /task_id = \$2::uuid[\s\S]+action_type = \$3[\s\S]+target = \$4/u);
  assert.match(dismissal, /status = 'dismissed'/u);
});

test("successful approval execution dismisses failed or pending sibling attempts", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const execution = source.slice(source.indexOf("export async function markActionApprovalExecution"), source.indexOf("export async function claimActionApprovalExecution"));
  assert.match(execution, /if \(input\.status === "executed"\)/u);
  assert.match(execution, /id <> \$1::uuid[\s\S]+task_id is not distinct from \$3::uuid[\s\S]+status in \('pending', 'approved', 'failed'\)/u);
  assert.match(execution, /Superseded by a successfully executed approval/u);
});

test("workers claim only tasks whose pinned or resolved default provider they advertise", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /claimNextWorkflowTask\(input\?: \{[^}]*providerIds\?: string\[\]/u);
  assert.match(source, /input\?\.providerIds === undefined \? null/u);
  assert.match(source, /cardinality\(\$4::text\[\]\) > 0/u);
  assert.match(source, /\$4::text\[\] is null[\s\S]+?= any\(\$4::text\[\]\)/u);
  assert.match(source, /nullif\(nullif\(\$7::text, 'default'\), 'auto'\)/u);
  assert.match(source, /\[workerId, leaseSeconds, projectRootUri, providerIds, excludedProjectRootUris, perProjectConcurrency, defaultProviderId, workerPlatform\]/u);
});

test("workers claim only projects that allow their operating-system platform", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /allowed_platforms[\s\S]+\$8::text[\s\S]+jsonb_array_elements_text/u);
});

test("workers can exclude project checkouts unavailable on their host", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /excludedProjectRootUris[\s\S]+not \(p\.root_uri = any\(\$5::text\[\]\)\)/u);
});

test("global workers enforce fair bounded project concurrency while preserving run order", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const claim = source.slice(source.indexOf("export async function claimNextWorkflowTask"), source.indexOf("export async function startWorkflowTask"));
  assert.match(claim, /pg_advisory_xact_lock\(hashtext\('agentflow:workflow-task-scheduler'\)\)/u);
  assert.match(claim, /project_active\.status in \('leased', 'running'\)[\s\S]+< \$6::int/u);
  assert.match(claim, /order by[\s\S]+count\(\*\)[\s\S]+wt\.available_at asc/u);
  assert.match(claim, /not exists \([\s\S]+active\.run_id = wt\.run_id[\s\S]+active\.status in \('leased', 'running'\)/u);
  assert.match(claim, /active\.worker_id is distinct from \$1[\s\S]+parallel_group[\s\S]+active_stage->>'parallel_group'/u);
  assert.match(claim, /prior\.status <> 'completed'/u);
});

test("dismissed terminal runs remain immutable history but leave the actionable queue", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /export async function listWorkflowQueue[\s\S]+not exists \([\s\S]+dismissed\.run_id = wr\.id[\s\S]+dismissed\.action_type = 'failed_run_dismissed'/u
  );
  assert.match(
    source,
    /export async function dismissFailedWorkflowRun[\s\S]+select wr\.id::text[\s\S]+failed_run_dismissed/u
  );
  assert.match(source, /export async function reinstateFailedWorkflowRun[\s\S]+failed_run_reinstated/u);
  assert.match(source, /export async function listWorkflowQueue[\s\S]+reinstated\.created_at > dismissed\.created_at/u);
});

test("queue items expose replay and repair recovery relationships without rewriting lifecycle state", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /recovery\.id as "recoveryRunId"/u);
  assert.match(source, /next_run\.evaluation_metadata->>'replayOfRunId' = wr\.id::text[\s\S]+next_run\.evaluation_metadata->>'sourceRunId' = wr\.id::text/u);
  assert.match(source, /recovery\.relation as "recoveryRelation"/u);
  assert.match(source, /with recursive descendants as/u);
  assert.match(source, /parent\.depth < 20 and not child\.id = any\(parent\.path\)/u);
});

test("queue and run detail expose the latest recorded stage failure reason", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /ar\.action_type = 'stage_failed'[\s\S]+as "failedReason"/u);
  assert.match(source, /metadata->>'failureReason'/u);
  assert.match(source, /failedReason\?: string \| null/u);
});

test("evaluation failures remain evidence instead of actionable queue items", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /export async function listWorkflowQueue[\s\S]+not \(wr\.status in \('failed', 'blocked'\) and wr\.evaluation_metadata \? 'suiteId'\)/u
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
  assert.match(source, /replayWorkflowRun\(\{[\s\S]+sourceRunId: input\.runId[\s\S]+preserveCompletedCheckpoints: true/u);
  assert.doesNotMatch(source, /update workflow_runs[\s\S]{0,120}set status = 'queued'/u);
  assert.match(source, /replacementRunId: replay\?\.runId/u);
  assert.match(source, /Superseded by replacement run \$\{replay\.runId\}/u);
});

test("approval-level changes preserve immutable runs and audit queued updates", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /autonomyOverride\?: string/u);
  assert.match(source, /input\.autonomyOverride \?\? sourceRun\.autonomy/u);
  assert.match(source, /export async function setQueuedWorkflowRunAutonomy/u);
  assert.match(source, /and status = 'queued'/u);
  assert.match(source, /run_autonomy_changed/u);
});

test("checkpoint replacement preserves completed stages and queues only unfinished work", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const replay = source.slice(source.indexOf("export async function replayWorkflowRun"), source.indexOf("async function createWorkflowHandoffsForRun"));
  assert.match(replay, /sourceTask\?\.status === "completed" \|\| actionResolvedCheckpoint/u);
  assert.match(replay, /sourceTask\.artifactContent !== null/u);
  assert.match(replay, /preserveCheckpoint \|\| skipStage \? "completed" : "queued"/u);
  assert.match(replay, /stage_checkpoint_preserved/u);
  assert.match(replay, /checkpointPreservedFromRunId/u);
  assert.match(replay, /completedTasks[\s\S]+queuedTasks: workflow\.stages\.length - completedTasks - skippedTasks/u);
  assert.match(source, /retryFailedWorkflowRun[\s\S]+preserveCompletedCheckpoints: true/u);
  assert.match(source, /return replay\?\.queuedTasks \?\? 0/u);
  assert.match(replay, /\.\.\.input\.evaluationMetadataPatch[\s\S]+replayOfRunId: input\.sourceRunId/u);
});

test("checkpoint replacement preserves blocked stages after every required action executes", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /actionResolvedCheckpoint = sourceTask\?\.status === "blocked"/u);
  assert.match(source, /sourceTask\.executedApprovalCount === sourceTask\.approvalCount/u);
  assert.match(source, /Preserved action-resolved checkpoint/u);
});

test("checkpoint replay atomically reserves one replacement per source run", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const replay = source.slice(source.indexOf("export async function replayWorkflowRun"), source.indexOf("export async function setQueuedWorkflowRunAutonomy"));
  assert.match(source, /ADD COLUMN IF NOT EXISTS replacement_run_id uuid REFERENCES workflow_runs\(id\)/u);
  assert.match(source, /ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now\(\)/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS workflow_runs_replacement_run_idx/u);
  assert.match(replay, /for update of wr/u);
  assert.match(replay, /if \(sourceRun\.replacementRunId\)/u);
  assert.match(replay, /set replacement_run_id = \$2::uuid/u);
});

test("checkpoint replay finalizes immediately when every stage is already complete", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /if \(queuedTasks === 0\)[\s\S]+to: "leased"[\s\S]+to: "running"[\s\S]+to: "completed"/u);
});

test("operator-approved blocker skipping is explicit, receipted, and dependency-compatible", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /skipStageIds\?: string\[\]/u);
  assert.match(source, /preserveCheckpoint \|\| skipStage \? "completed" : "queued"/u);
  assert.match(source, /'stage_blocker_ignored'/u);
  assert.match(source, /skipReason: input\.reason/u);
  assert.match(source, /queuedTasks: workflow\.stages\.length - completedTasks - skippedTasks/u);
});

test("run details preserve immutable workflow stage order", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const details = source.slice(source.indexOf("export async function getWorkflowRunDetails"));
  assert.match(details, /jsonb_array_elements\(coalesce\(nullif\(wr\.workflow_snapshot/u);
  assert.match(details, /with ordinality stage\(definition, stage_order\)/u);
  assert.match(details, /order by stage\.stage_order asc/u);
});

test("replay never restores stale project configuration over current policy", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const replay = source.slice(source.indexOf("export async function replayWorkflowRun"));
  const projectUpsert = replay.slice(replay.indexOf("insert into projects"), replay.indexOf("returning id"));
  assert.doesNotMatch(projectUpsert, /config = excluded\.config/u);
  assert.match(replay, /resolveExecutionPolicy\(sourceRun\.projectConfig as ProjectConfig, sourceRun\.policyProfile\)/u);
  assert.match(replay, /JSON\.stringify\(replayPolicySnapshot\)[\s\S]{0,100}replayPolicySnapshotHash/u);
});

test("retry dismisses superseded terminal history after creating its replacement", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /retryFailedWorkflowRun[\s\S]+replayWorkflowRun[\s\S]+dismissFailedWorkflowRun[\s\S]+Superseded by replacement run/u);
});

test("stale terminal run reconciliation only repairs terminal child-task runs", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /export async function listStaleTerminalWorkflowRuns[\s\S]+wr\.status in \('queued', 'leased', 'running'\)[\s\S]+having count\(\*\) > 0[\s\S]+wt\.status in \('queued', 'leased', 'running', 'failed'\)\) = 0/u
  );
  assert.match(
    source,
    /export async function reconcileStaleTerminalWorkflowRuns[\s\S]+active\.status in \('queued', 'leased', 'running', 'failed'\)[\s\S]+to: "leased"[\s\S]+to: "running"[\s\S]+'stale_run_reconciled'/u
  );
});

test("task leases use a distinct leased state and fenced terminal writes", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /acquireWorkflowRunLease[\s\S]+lease_epoch = lease_epoch \+ 1/u);
  assert.match(source, /update workflow_tasks set lease_generation = \$2::bigint/u);
  assert.match(source, /export async function startWorkflowTask[\s\S]+status='leased'[\s\S]+lease_generation=\$4::bigint/u);
  assert.match(source, /assertActiveTaskFence[\s\S]+wt\.status='running'[\s\S]+wt\.lease_generation=\$3::bigint[\s\S]+wr\.lease_epoch=\$3::bigint/u);
  assert.match(source, /export async function completeWorkflowTask[\s\S]+await assertActiveTaskFence\(client, input\)/u);
  assert.match(source, /export async function renewWorkflowTaskLease[\s\S]+lease_generation = \$4::bigint[\s\S]+lease_expires_at > now\(\)/u);
});

test("unified activity query covers workflow, stage, action, and approval evidence", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /export async function listActivityEvents/u);
  for (const table of ["workflow_runs", "workflow_tasks", "action_receipts", "action_approvals"]) {
    assert.match(source, new RegExp(`from ${table}`, "u"));
  }
  assert.match(source, /order by occurred_at desc/u);
  assert.match(source, /\(\$3::uuid is null or run_id = \$3::uuid\)/u);
});

test("approval execution is atomically claimed before dispatch", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /ADD COLUMN IF NOT EXISTS execution_claim_token uuid/u);
  assert.match(source, /export async function claimActionApprovalExecution/u);
  assert.match(source, /export async function recoverInterruptedActionApprovalExecutions/u);
  assert.match(source, /action_approval_execution_recovered/u);
  assert.match(source, /aa\.executed_by = \$1/u);
  assert.match(source, /set status = 'executing'[\s\S]+execution_claim_token = gen_random_uuid\(\)/u);
  assert.match(source, /aa\.execution_claim_token = \$6::uuid/u);
});

test("side effects are reserved before dispatch and uncertain claims are not replayed", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS side_effect_receipts[\s\S]+status text NOT NULL DEFAULT 'completed'[\s\S]+claim_token uuid[\s\S]+claim_expires_at timestamptz/u);
  const reliabilitySource = readFileSync(new URL("./reliability.ts", import.meta.url), "utf8");
  assert.match(reliabilitySource, /export async function claimSideEffect[\s\S]+status='uncertain'/u);
  assert.match(reliabilitySource, /export async function finalizeSideEffect[\s\S]+status='pending'[\s\S]+claim_token=\$3::uuid/u);
  const executorSource = readFileSync(new URL("../../workflow-engine/src/executor.ts", import.meta.url), "utf8");
  assert.match(executorSource, /claimSideEffect[\s\S]+executeAllowedCommand/u);
  assert.match(executorSource, /claimSideEffect[\s\S]+executeAllowedFileWrite/u);
  assert.match(executorSource, /type\.includes\("_side_effect_"\)/u);
});

test("project execution locks serialize conflicting build resources across workers", () => {
  const source = readFileSync(new URL("./reliability.ts", import.meta.url), "utf8");
  assert.match(source, /withProjectExecutionLock[\s\S]+pg_advisory_lock\(hashtext\(\$1\)\)[\s\S]+pg_advisory_unlock\(hashtext\(\$1\)\)/u);
});

test("all run lifecycle writes route through the authoritative transition helper", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const directStatusWrites = [...source.matchAll(/update workflow_runs[\s\S]{0,140}?set status\s*=\s*['$]/gu)];
  assert.equal(directStatusWrites.length, 1, "only transitionWorkflowRun may perform runtime workflow_runs.status writes");
  assert.match(source, /workflow_run_transitions[\s\S]+UNIQUE\(run_id, idempotency_key\)[\s\S]+UNIQUE\(run_id, state_version\)/u);
  assert.match(source, /WHERE NOT EXISTS \([\s\S]+workflow_run_transitions existing WHERE existing\.run_id = wr\.id/u);
  assert.match(source, /assertWorkflowRunFence\(/u);
});

test("concurrent parallel-group claims share one worker fence while other claims advance it", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /select status, lease_epoch::text as "leaseEpoch", lease_owner as "leaseOwner" from workflow_runs where id = \$1::uuid for update/u);
  assert.match(source, /run\.leaseOwner === input\.workerId[\s\S]+set lease_expires_at = now\(\)/u);
  assert.match(source, /lease_epoch = lease_epoch \+ 1/u);
  assert.match(source, /sibling\.id <> \$4::uuid[\s\S]+sibling\.status in \('leased', 'running'\)/u);
  assert.match(source, /wr\.lease_owner=\$2 and wr\.lease_epoch=\$3::bigint/u);
});

function compactSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ").slice(0, 220);
}
