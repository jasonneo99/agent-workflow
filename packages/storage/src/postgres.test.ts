import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function storageFunction(file: string, name: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${file} must declare ${name}`);
  return source.slice(declaration.getStart(parsed), declaration.end);
}

test("storage facade preserves task authority and outcome export identities", async () => {
  const api = await import("./postgres.js"), authority = await import("./workflow-task-authority.js"), outcomes = await import("./workflow-task-outcomes.js");
  for (const name of ["checkpointWorkflowTaskContinuation", "holdWorkflowTaskForApprovals", "workflowRunLeaseTransitionKey",
    "requeueRunningWorkflowTasks", "requeueExpiredWorkflowTaskLeases", "startWorkflowTask", "assertWorkflowTaskLease", "renewWorkflowTaskLease"] as const) {
    assert.equal(api[name], authority[name], name);
  }
  for (const name of ["cancelWorkflowRun", "completeWorkflowTask", "blockWorkflowTask", "failWorkflowTask"] as const) {
    assert.equal(api[name], outcomes[name], name);
  }
});

test('production blocked-stage persistence seals the actual JSON-normalized output without completing it',async()=>{
 const {withClient}=await import('./client.js'),api=await import('./postgres.js');
 const {acceptanceDigest}=await import('./acceptance.js');
 const {projectConfigSchema,workflowSchema}=await import('../../agent-registry/src/schemas.js');
 const {randomUUID}=await import('node:crypto'),fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 // This is an actual persistence roundtrip, never a configured-database fixture.
 await withClient(async c=>assert.match((await c.query('select current_database() name')).rows[0].name,/^agentflow_suite_test_[a-f0-9]{32}$/u));
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'blocked-output-proof-'))),id=`blocked-proof-${randomUUID()}`;
 try{
  const workflow=workflowSchema.parse({id,name:'Synthetic blocked output proof',description:'Bounded persisted evidence',lead:'implementation-agent',stages:[{id:'inspect',agent:'implementation-agent',goal:'Inspect synthetic evidence',output:'evidence'}]});
  await withClient(async c=>{
   await c.query("insert into agents(id,display_name,category,source_path,definition) values('implementation-agent','Synthetic implementer','test','synthetic','{}'),('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}') on conflict(id) do nothing");
   await c.query("insert into workflows(id,name,source_path,definition) values($1,$2,'synthetic',$3)",[id,workflow.name,JSON.stringify(workflow)]);
  });
  const config=projectConfigSchema.parse({project:{name:'Synthetic blocked proof',autonomy:2}});
  const run=await api.createWorkflowRun({projectName:'Synthetic blocked proof',projectRootUri:root,projectProfile:'test',projectConfig:config,workflow,task:'Inspect a bounded synthetic source scope',autonomy:'2',policyProfile:'local',policySnapshot:config,policySnapshotHash:'0'.repeat(64)});
  const task=await api.claimNextWorkflowTask({runId:run.runId,projectRootUri:root,workerId:'synthetic-proof'});assert.ok(task);
  await api.startWorkflowTask({taskId:task.taskId,runId:run.runId,workerId:'synthetic-proof',fencingToken:task.fencingToken});
  const artifact={runId:run.runId,taskId:task.taskId,agentId:'implementation-agent',outcome:'blocked',summary:'Additional exact source is needed',proposedSourcePaths:['src/feature.ts','tests/feature.test.ts'],nested:{z:1,a:2},absent:undefined,nonfinite:NaN};
  await api.blockWorkflowTask({taskId:task.taskId,runId:run.runId,agentId:'implementation-agent',workerId:'synthetic-proof',fencingToken:task.fencingToken,summary:artifact.summary,reason:'Exact next scope required',artifact});
  await withClient(async c=>{
   const row=(await c.query("select a.content,p.metadata,r.status,t.status task_status from artifacts a join workflow_runs r on r.id=a.run_id join workflow_tasks t on t.id=a.task_id join action_receipts p on p.run_id=a.run_id and p.target=a.task_id::text and p.action_type='stage_blocked' where a.run_id=$1 and a.kind='stage_output'",[run.runId])).rows[0];
   assert.deepEqual(row.content,JSON.parse(JSON.stringify(artifact)));assert.equal(row.metadata.outputDigest,acceptanceDigest(row.content));assert.equal(row.metadata.outputUri,`db://workflow_tasks/${task.taskId}/output`);
   assert.equal(row.status,'blocked');assert.equal(row.task_status,'blocked');
  });
  assert.equal((await api.verifyRunReceiptChain(run.runId)).valid,true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("automatic broad wrapper rejection precedes filesystem registration and every storage write", async () => {
  const {createWorkflowRun} = await import('./postgres.js');
  await assert.rejects(() => createWorkflowRun({
    projectRootUri: '/synthetic-unavailable-project',
    task: 'Resolve every failed or blocked queue item for this project.',
    evaluationMetadata: {source: 'server-orchestration', actorRole: 'operator'}
  } as unknown as Parameters<typeof createWorkflowRun>[0]), /Catch-all queue recovery wrappers/u);
  const source = readFileSync(new URL('./postgres.ts', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('export async function createWorkflowRun('));
  assert.ok(create.indexOf('automaticRecoveryWrapperReason(input)') < create.indexOf('projectRegistrationRoot('));
  assert.ok(create.indexOf('automaticRecoveryWrapperReason(input)') < create.indexOf('insert into projects'));
});

test("storage SQL does not reuse one parameter with conflicting casts", () => {
  const queryPattern = /client\.query(?:<[^>]+>)?\(\s*`([\s\S]*?)`/gu;
  const failures: string[] = [];

  for (const file of ["./postgres.ts", "./workflow-task-authority.ts", "./workflow-task-outcomes.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(queryPattern)) {
      const sql = match[1];
      const parameterNumbers = new Set([...sql.matchAll(/\$(\d+)/gu)].map((item) => item[1]));
      for (const parameterNumber of parameterNumbers) {
        const casts = new Set(
          [...sql.matchAll(new RegExp(`\\$${parameterNumber}::([a-zA-Z_][a-zA-Z0-9_\\[\\]]*)`, "gu"))]
            .map((item) => item[1])
        );
        if (casts.size > 1) {
          failures.push(`${file}: $${parameterNumber} is cast as ${[...casts].join(", ")} in ${compactSql(sql)}`);
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("project alias consolidation is transactional and preserves durable run history", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const implementation = source.slice(source.indexOf("export async function consolidateProjectAlias"));
  assert.match(implementation, /await client\.query\("begin"\)/u);
  assert.match(implementation, /update workflow_runs set project_id/u);
  assert.match(implementation, /update project_files set project_id/u);
  assert.match(implementation, /update memory_items set project_id/u);
  assert.match(implementation, /source\.updated_at > target\.updated_at/u);
  assert.match(implementation, /expected exactly/u);
  assert.match(implementation, /select run\.id::text from workflow_runs run where run\.project_id[\s\S]+coalesce\(started_at, updated_at\)/u);
  assert.match(implementation, /legacy\.receipt_hash is null/u);
  assert.match(implementation, /delete from projects where id/u);
  assert.match(implementation, /await client\.query\("rollback"\)/u);
});

test("queue action receipt inserts use separate uuid and text parameters", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const authority = readFileSync(new URL("./workflow-task-authority.ts", import.meta.url), "utf8");
  const writer = readFileSync(new URL("./receipt-writer.ts", import.meta.url), "utf8");
  for (const action of ["expired_worker_lease_requeued", "checkpoint_resume_requested", "failed_run_dismissed"]) {
    assert.match(action === "expired_worker_lease_requeued" ? authority : source, new RegExp(`appendActionReceipt\\(client, \\{[^}]+actionType: "${action}"[^}]+target:`));
  }
  // UUID identity and text target are independently bound by the shared writer.
  assert.match(writer, /values \(\$1::uuid, \$2, \$3, \$4, \$5, \$6::jsonb/u);
  assert.match(writer, /input\.runId, input\.agentId, input\.actionType, input\.target/u);
});

test("successful direct actions dismiss stale approval cards for the same task and target", () => {
  const source = readFileSync(new URL("./action-approvals.ts", import.meta.url), "utf8");
  const dismissal = source.slice(source.indexOf("export async function dismissSupersededActionApprovals"), source.indexOf("export async function decideActionApproval"));
  assert.match(dismissal, /status in \('pending', 'approved', 'failed'\)/u);
  assert.match(dismissal, /task_id = \$2::uuid[\s\S]+action_type = \$3[\s\S]+target = \$4/u);
  assert.match(dismissal, /status = 'dismissed'/u);
});

test("successful approval execution dismisses failed or pending sibling attempts", () => {
  const source = readFileSync(new URL("./action-approvals.ts", import.meta.url), "utf8");
  const execution = source.slice(source.indexOf("export async function markActionApprovalExecution"), source.indexOf("export async function claimActionApprovalExecution"));
  assert.match(execution, /if \(input\.status === "executed"\)/u);
  assert.match(execution, /id <> \$1::uuid[\s\S]+task_id is not distinct from \$3::uuid[\s\S]+status in \('pending', 'approved', 'failed'\)/u);
  assert.match(execution, /Superseded by a successfully executed approval/u);
});

test("approval backlog can count all records and inspect the newest bounded window", () => {
  const source = readFileSync(new URL("./action-approvals.ts", import.meta.url), "utf8");
  assert.match(source, /export async function countActionApprovals/u);
  assert.match(source, /select count\(\*\)::int as count/u);
  assert.match(source, /input\.order === "recent"[\s\S]+aa\.created_at desc/u);
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
  const claim = storageFunction("./postgres.ts", "claimNextWorkflowTask");
  assert.match(claim, /pg_advisory_xact_lock\(hashtext\('agentflow:workflow-task-scheduler'\)\)/u);
  assert.match(claim, /project_active\.status in \('leased', 'running'\)[\s\S]+< \$6::int/u);
  assert.match(claim, /order by[\s\S]+count\(\*\)[\s\S]+wt\.available_at asc/u);
  assert.match(claim, /not exists \([\s\S]+active\.run_id = wt\.run_id[\s\S]+active\.status in \('leased', 'running'\)/u);
  assert.match(claim, /active\.worker_id is distinct from \$1[\s\S]+parallel_group[\s\S]+active_stage->>'parallel_group'/u);
  assert.match(claim, /prior\.status <> 'completed'/u);
  assert.match(storageFunction("./workflow-task-authority.ts", "coordinatorWorkerFencePredicate"), /intent\.project_id=assignment\.project_id::text/u);
});

test("dismissed terminal runs remain immutable history but leave the actionable queue", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /export async function listWorkflowQueue[\s\S]+not exists \([\s\S]+dismissed\.run_id = wr\.id[\s\S]+dismissed\.action_type in \('failed_run_dismissed', 'failed_run_superseded'\)/u
  );
  assert.match(
    source,
    /export async function dismissFailedWorkflowRun[\s\S]+select wr\.id::text[\s\S]+failed_run_dismissed/u
  );
  assert.match(source, /export async function reinstateFailedWorkflowRun[\s\S]+failed_run_reinstated/u);
  assert.match(source, /export async function listWorkflowQueue[\s\S]+reinstated\.created_at > dismissed\.created_at/u);
});

test("project queue scopes lineage before recursive family expansion", () => {
  const queue = storageFunction("./postgres.ts", "listWorkflowQueue");
  assert.match(queue, /queuePresentationSql\(identityFamilies, "\$2"\)/u);
});

test("queue cards sort by the latest durable family activity", () => {
  const queue = storageFunction("./postgres.ts", "listWorkflowQueue");
  assert.match(queue, /max\(receipt\.created_at\)[\s\S]+max\(approval\.updated_at\)[\s\S]+task_activity\.finished_at/u);
  assert.match(queue, /"latestActivityAt" desc,[\s\S]+wr\.id desc/u);
  assert.doesNotMatch(queue, /case wr\.status when 'running' then 0/u);
});

test("superseded terminal runs are explicit history and leave the actionable queue", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const supersession = readFileSync(new URL("./run-supersession.ts", import.meta.url), "utf8");
  assert.match(supersession, /export async function supersedeWorkflowRun[\s\S]+failed_run_superseded/u);
  assert.match(source, /export async function listWorkflowQueue[\s\S]+failed_run_dismissed',\s*'failed_run_superseded'/u);
  assert.match(source, /as dismissed,[\s\S]+failed_run_superseded[\s\S]+as superseded/u);
});

test("queue items expose replay and repair recovery relationships without rewriting lifecycle state", () => {
  const queue = storageFunction("./postgres.ts", "listWorkflowQueue");
  assert.match(queue, /join workflow_runs child on child\.id = source\.replacement_run_id/u);
  assert.match(queue, /source\.id = any\(\$1::uuid\[\]\)/u);
  assert.match(queue, /for \(let depth = 0; depth < 20/u);
  assert.match(queue, /visited\.has\(edge\.id\)/u);
  assert.match(queue, /recoveryRunId: recovery\.id/u);
  assert.doesNotMatch(queue, /with recursive descendants as/u);
});

test("queue items carry durable project identity and frozen source revision for worker eligibility",()=>{
 const queue=storageFunction("./postgres.ts","listWorkflowQueue");
 assert.match(queue,/project_identity_locations where project_id=p\.id/);
 assert.match(queue,/as "projectIdentityId"/);
 assert.match(queue,/as "projectIdentityGeneration"/);
 assert.match(queue,/jsonb_each\(coalesce\(wr\.executor_snapshot/);
 assert.match(queue,/as "sourceRevision"/);
});

test("run sets group immutable recovery history behind one queue representative", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const runSets = readFileSync(new URL("./run-sets.ts", import.meta.url), "utf8");
  assert.match(runSets, /ADD COLUMN IF NOT EXISTS run_set_id uuid/u);
  assert.match(runSets, /sourceRunId'[\s\S]+replayOfRunId/u);
  assert.match(source, /wr\.run_set_id::text as "runSetId"/u);
  assert.match(runSets, /member\.run_set_id = wr\.run_set_id/u);
  assert.match(source, /history\.run_set_id = wr\.run_set_id/u);
  assert.match(source, /run_set_id\)[\s\S]+inheritedRunSetSql/u);
});

test("completed attempts remain in history but never represent actionable queue cards", () => {
  const lineage = readFileSync(new URL("./queue-lineage.ts", import.meta.url), "utf8");
  assert.match(lineage, /and \$\{activeQueueRunPredicateSql\("latest"\)\}/u);
  assert.match(lineage, /return `\$\{alias\}\.status in \('queued','leased','running','blocked','failed'\)`/u);
  assert.doesNotMatch(lineage, /latest\.status in \([^)]*completed/u);
});

test("queue and dashboard lookups have indexes for recovery, receipts, and task state", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /CREATE INDEX IF NOT EXISTS workflow_runs_status_started_idx[\s\S]+ON workflow_runs\(status, started_at DESC\)/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS workflow_runs_replay_source_idx[\s\S]+evaluation_metadata->>'replayOfRunId'/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS workflow_runs_repair_source_idx[\s\S]+evaluation_metadata->>'sourceRunId'/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_schedule_idx[\s\S]+ON workflow_tasks\(run_id, status, available_at, started_at\)/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS action_receipts_run_type_created_idx[\s\S]+ON action_receipts\(run_id, action_type, created_at DESC\)/u);
});

test("migration moves legacy metadata lineage onto the indexed replacement relation", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /WITH legacy_replacements AS/u);
  assert.match(source, /child\.evaluation_metadata->>'replayOfRunId' = source\.id::text/u);
  assert.match(source, /child\.evaluation_metadata->>'sourceRunId' = source\.id::text/u);
  assert.match(source, /SET replacement_run_id = legacy\.replacement_id/u);
});

test("queue and run detail expose the latest recorded stage failure reason", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const types = readFileSync(new URL("./workflow-run-types.ts", import.meta.url), "utf8");
  assert.match(source, /ar\.action_type = 'stage_failed'[\s\S]+as "failedReason"/u);
  assert.match(source, /metadata->>'failureReason'/u);
  assert.match(types, /failedReason\?: string \| null/u);
});

test("evaluation failures remain evidence instead of actionable queue items", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /export async function listWorkflowQueue[\s\S]+not \(wr\.status in \('failed', 'blocked'\) and wr\.evaluation_metadata \? 'suiteId'\)/u
  );
});

test("completed retried tasks can finalize runs with cancelled downstream tasks", () => {
  const source = readFileSync(new URL("./workflow-task-outcomes.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /set status = 'completed'[\s\S]+not exists \([\s\S]+wt\.status in \('queued', 'leased', 'running', 'failed', 'blocked'\)/u
  );
});

test("blocked stage output terminates the run without reporting success", () => {
  const source = readFileSync(new URL("./workflow-task-outcomes.ts", import.meta.url), "utf8");

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
  const recovery = source.slice(source.indexOf("export async function resumeWorkflowRunFromCheckpoint("), source.indexOf("export async function dismissFailedWorkflowRun("));
  assert.doesNotMatch(recovery, /await dismissFailedWorkflowRun/u);
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
  assert.match(replay, /checkpointCandidate = sourceTask\?\.status === "completed";/u);
  assert.match(replay, /checkpointArtifact !== null/u);
  assert.match(replay, /completedStageProvidesPinnedBuildEvidence/u);
  assert.match(replay, /checkpointChainInvalidated/u);
  assert.match(replay, /preserveCheckpoint \|\| skipStage \? "completed" : "queued"/u);
  assert.match(replay, /stage_checkpoint_preserved/u);
  assert.match(replay, /checkpointPreservedFromRunId/u);
  assert.match(replay, /completedTasks[\s\S]+queuedTasks: workflow\.stages\.length - completedTasks - skippedTasks/u);
  assert.match(source, /retryFailedWorkflowRun[\s\S]+preserveCompletedCheckpoints: true/u);
  assert.match(source, /return replay\?\.queuedTasks \?\? 0/u);
  assert.match(replay, /\.\.\.input\.evaluationMetadataPatch[\s\S]+replayOfRunId: input\.sourceRunId/u);
});

test("executed approvals cannot promote a blocked stage into a completed checkpoint", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /checkpointCandidate = sourceTask\?\.status === "completed";/u);
  assert.doesNotMatch(source, /const actionResolvedCheckpoint =/u);
  assert.doesNotMatch(source, /Preserved action-resolved checkpoint/u);
});

// Explicit integration opt-in: requires CREATEDB, never touches configured rows.
test("production replay requeues an approval-resolved blocked stage in a disposable database",
  {skip:process.env.AGENTFLOW_REPLAY_INTEGRATION !== "1"},async()=>{
  const {randomUUID}=await import("node:crypto");
  const {default:pg}=await import("pg");
  const {databaseUrl}=await import("./client.js");
  const api=await import("./postgres.js");
  const {projectConfigSchema,workflowSchema}=await import("../../agent-registry/src/schemas.js");
  const configured=databaseUrl();const previous=process.env.DATABASE_URL;
  const name=`agentflow_replay_guard_${randomUUID().replaceAll("-","")}`;
  assert.match(name,/^agentflow_replay_guard_[a-f0-9]{32}$/u);
  const isolated=new URL(configured);isolated.pathname=`/${name}`;
  const admin=new pg.Client({connectionString:configured});let created=false;
  let client:InstanceType<typeof pg.Client>|undefined;
  try {
    await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
    process.env.DATABASE_URL=isolated.href;
    client=new pg.Client({connectionString:isolated.href});await client.connect();
    await client.query(readFileSync(new URL("../../../infra/init.sql",import.meta.url),"utf8"));
    await api.migrateStorage();
    await client.query("INSERT INTO agents(id,display_name,category,source_path,definition) VALUES ('replay-guard-fixture','Synthetic','test','synthetic','{}'),('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}')");
    const workflow=workflowSchema.parse({id:'replay-guard-fixture',name:'Synthetic replay guard',description:'Isolated legacy replay',lead:'replay-guard-fixture',stages:[{id:'inspect',agent:'replay-guard-fixture',goal:'Inspect synthetic evidence',output:'evidence'}]});
    await client.query("INSERT INTO workflows(id,name,source_path,definition) VALUES ($1,$2,'synthetic',$3)",[workflow.id,workflow.name,JSON.stringify(workflow)]);
    const config=projectConfigSchema.parse({project:{name:'Synthetic replay guard',autonomy:2}});
    const root=`/tmp/agentflow-synthetic-replay-guard-${randomUUID()}`;
    const source=await api.createWorkflowRun({projectName:'Synthetic replay guard',projectRootUri:root,projectProfile:'test',projectConfig:config,workflow,task:'Inspect a synthetic fixture',autonomy:'2',policyProfile:'local',policySnapshot:config,policySnapshotHash:'0'.repeat(64)});
    const task=await api.claimNextWorkflowTask({projectRootUri:root,workerId:'fixture'});assert.ok(task);
    await api.startWorkflowTask({taskId:task.taskId,runId:source.runId,workerId:'fixture',fencingToken:task.fencingToken});
    await api.blockWorkflowTask({taskId:task.taskId,runId:source.runId,agentId:task.agentId,workerId:'fixture',fencingToken:task.fencingToken,summary:'Prerequisite required; assessment pending',reason:'Await prerequisite',artifact:{summary:'Assessment pending'}});
    await client.query("INSERT INTO action_approvals(run_id,task_id,stage_id,agent_id,action_type,target,status,rationale,idempotency_key) VALUES ($1,$2,'inspect','replay-guard-fixture','project_policy_change','synthetic','executed','Synthetic prerequisite executed','synthetic')",[source.runId,task.taskId]);
    const beforeArtifacts=(await client.query("SELECT id,content FROM artifacts WHERE run_id=$1 ORDER BY id",[source.runId])).rows;
    const beforeReceipts=(await client.query("SELECT id,receipt_hash,summary FROM action_receipts WHERE run_id=$1 ORDER BY id",[source.runId])).rows;
    const replay=await api.replayWorkflowRun({sourceRunId:source.runId,actor:'fixture',reason:'Verify blocked stage is not complete',preserveCompletedCheckpoints:true});assert.ok(replay);
    assert.equal(replay.completedTasks,0);assert.equal(replay.queuedTasks,1);
    assert.equal((await client.query("SELECT status FROM workflow_tasks WHERE run_id=$1",[replay.runId])).rows[0].status,'queued');
    assert.equal((await client.query("SELECT status FROM workflow_runs WHERE id=$1",[source.runId])).rows[0].status,'blocked');
    assert.deepEqual((await client.query("SELECT id,content FROM artifacts WHERE id=ANY($1::uuid[]) ORDER BY id",[beforeArtifacts.map(r=>r.id)])).rows,beforeArtifacts);
    assert.deepEqual((await client.query("SELECT id,receipt_hash,summary FROM action_receipts WHERE id=ANY($1::uuid[]) ORDER BY id",[beforeReceipts.map(r=>r.id)])).rows,beforeReceipts);
    const once=await api.createWorkflowRun({projectName:'Synthetic replay guard',projectRootUri:root,projectProfile:'test',projectConfig:config,workflow,task:'One expressly approved readonly assessment',autonomy:'2',policyProfile:'local',policySnapshot:config,policySnapshotHash:'0'.repeat(64),evaluationMetadata:{noAutomaticRepeat:true,kind:'explicit-independent-acceptance-review'}});
    const onceTask=await api.claimNextWorkflowTask({projectRootUri:root,runId:once.runId,workerId:'fixture'});assert.ok(onceTask);
    await api.startWorkflowTask({taskId:onceTask.taskId,runId:once.runId,workerId:'fixture',fencingToken:onceTask.fencingToken});
    await api.blockWorkflowTask({taskId:onceTask.taskId,runId:once.runId,agentId:onceTask.agentId,workerId:'fixture',fencingToken:onceTask.fencingToken,summary:'Exact action approval needed',reason:'Await exact action',artifact:{summary:'Incomplete readonly assessment'}});
    await client.query("INSERT INTO action_approvals(run_id,task_id,stage_id,agent_id,action_type,target,status,rationale,idempotency_key) VALUES ($1,$2,'inspect','replay-guard-fixture','command','git diff --check','executed','Exact command executed; no clone permission','one-shot')",[once.runId,onceTask.taskId]);
    const unchanged=async()=>({runs:(await client!.query('select * from workflow_runs order by id')).rows,tasks:(await client!.query('select * from workflow_tasks order by id')).rows,approvals:(await client!.query('select * from action_approvals order by id')).rows,receipts:(await client!.query('select * from action_receipts order by id')).rows});
    const beforeOnce=await unchanged();
    await assert.rejects(api.resumeWorkflowRunFromCheckpoint({runId:once.runId,actor:'approval',reason:'Approved action executed',includeFailed:true}),/one-shot review cannot be replayed or cloned/u);
    await assert.rejects(api.replayWorkflowRun({sourceRunId:once.runId,actor:'approval',reason:'No clone authorized',preserveCompletedCheckpoints:true}),/one-shot review cannot be replayed or cloned/u);
    assert.deepEqual(await unchanged(),beforeOnce);
  } finally {
    try {
      await client?.end();
      if(created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      try {await admin.end();} finally {
        if(previous===undefined) delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
      }
    }
  }
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

test("existing replacements do not report blocked or cancelled stages as queued", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf("if (sourceRun.replacementRunId)"), source.indexOf("const logicalProjectId", source.indexOf("if (sourceRun.replacementRunId)")));
  assert.match(branch, /count\(\*\) filter \(where status = 'queued'\)::int as "queuedTasks"/u);
  assert.match(branch, /queuedTasks: counts\.queuedTasks/u);
  assert.doesNotMatch(branch, /counts\.tasks - counts\.completedTasks/u);
});

test("rejected acceptance evidence is excluded from memory and reuse without deleting history", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const memory = source.slice(source.indexOf("export async function getLatestMemory"), source.indexOf("export async function consolidateProjectAlias"));
  assert.match(memory, /not exists[\s\S]+workflow_acceptance_rejected[\s\S]+repairRunId/u);
  const reuse = readFileSync(new URL("./reuse.ts", import.meta.url), "utf8");
  assert.equal((reuse.match(/workflow_acceptance_rejected/gu) ?? []).length, 2);
  assert.doesNotMatch(memory, /delete from/u);
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

test("retry preserves terminal history until independently verified recovery", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const recovery = source.slice(source.indexOf("export async function retryFailedWorkflowRun("), source.indexOf("export async function dismissFailedWorkflowRun("));
  assert.match(recovery, /replayWorkflowRun/u);
  assert.doesNotMatch(recovery, /await dismissFailedWorkflowRun/u);
});

test("stale terminal run reconciliation only repairs terminal child-task runs", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /export async function listStaleTerminalWorkflowRuns[\s\S]+wr\.status in \('queued', 'leased', 'running'\)[\s\S]+having count\(\*\) > 0[\s\S]+wt\.status in \('queued', 'leased', 'running', 'failed'\)\) = 0/u
  );
  assert.match(
    source,
    /export async function reconcileStaleTerminalWorkflowRuns[\s\S]+active\.status in \('queued', 'leased', 'running', 'failed'\)[\s\S]+to: "leased"[\s\S]+to: "running"[\s\S]+actionType: "stale_run_reconciled"/u
  );
});

test("task leases use a distinct leased state and fenced terminal writes", () => {
  const source = readFileSync(new URL("./workflow-task-authority.ts", import.meta.url), "utf8");
  assert.match(source, /acquireWorkflowRunLease[\s\S]+lease_epoch = lease_epoch \+ 1/u);
  assert.match(storageFunction("./postgres.ts", "claimNextWorkflowTask"), /update workflow_tasks set lease_generation = \$2::bigint/u);
  assert.match(source, /export async function startWorkflowTask[\s\S]+status='leased'[\s\S]+lease_generation=\$4::bigint/u);
  assert.match(source, /assertActiveTaskFence[\s\S]+wt\.status='running'[\s\S]+wt\.lease_generation=\$3::bigint[\s\S]+wr\.status in \('leased','running'\)/u);
  assert.match(storageFunction("./workflow-task-outcomes.ts", "completeWorkflowTask"), /export async function completeWorkflowTask[\s\S]+await assertActiveTaskFence\(client, input\)/u);
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
  const approvalsSource = readFileSync(new URL("./action-approvals.ts", import.meta.url), "utf8");
  assert.match(source, /ADD COLUMN IF NOT EXISTS execution_claim_token uuid/u);
  assert.match(approvalsSource, /export async function claimActionApprovalExecution/u);
  assert.match(approvalsSource, /export async function recoverInterruptedActionApprovalExecutions/u);
  assert.match(approvalsSource, /action_approval_execution_recovered/u);
  assert.match(approvalsSource, /aa\.executed_by = \$1/u);
  assert.match(approvalsSource, /set status = 'executing'[\s\S]+execution_claim_token = gen_random_uuid\(\)/u);
  assert.match(approvalsSource, /aa\.execution_claim_token = \$6::uuid/u);
});

test("side effects are reserved before dispatch and uncertain claims are not replayed", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS side_effect_receipts[\s\S]+status text NOT NULL DEFAULT 'completed'[\s\S]+claim_token uuid[\s\S]+claim_expires_at timestamptz/u);
  const reliabilitySource = readFileSync(new URL("./reliability.ts", import.meta.url), "utf8");
  assert.match(reliabilitySource, /export async function claimSideEffect[\s\S]+status='uncertain'/u);
  assert.match(reliabilitySource, /export async function finalizeSideEffect[\s\S]+status='pending'[\s\S]+claim_token=\$3::uuid/u);
  const executorSource = readFileSync(new URL("../../workflow-engine/src/executor.ts", import.meta.url), "utf8");
  const fileActionsSource = readFileSync(new URL("../../workflow-engine/src/stage-file-actions.ts", import.meta.url), "utf8");
  assert.match(executorSource, /claimSideEffect[\s\S]+executeAllowedCommand/u);
  assert.match(fileActionsSource, /claimSideEffect[\s\S]+executeAllowedFileMutation/u);
  assert.match(executorSource, /type\.includes\("_side_effect_"\)/u);
});

test("project execution locks serialize conflicting build resources across workers", () => {
  const source = readFileSync(new URL("./reliability.ts", import.meta.url), "utf8");
  assert.match(source, /withProjectExecutionLock[\s\S]+pg_advisory_lock\(hashtext\(\$1\)\)[\s\S]+pg_advisory_unlock\(hashtext\(\$1\)\)/u);
});

test("all run lifecycle writes route through the authoritative transition helper", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const transitionSource = readFileSync(new URL("./run-transitions.ts", import.meta.url), "utf8");
  const directStatusWrites = [...transitionSource.matchAll(/update workflow_runs[\s\S]{0,140}?set status\s*=\s*['$]/gu)];
  assert.equal(directStatusWrites.length, 1, "only transitionWorkflowRun may perform runtime workflow_runs.status writes");
  assert.match(source, /workflow_run_transitions[\s\S]+UNIQUE\(run_id, idempotency_key\)[\s\S]+UNIQUE\(run_id, state_version\)/u);
  assert.match(source, /WHERE NOT EXISTS \([\s\S]+workflow_run_transitions existing WHERE existing\.run_id = wr\.id/u);
  assert.match(transitionSource, /assertWorkflowRunFence\(/u);
});

test("concurrent parallel-group claims share one worker fence while other claims advance it", () => {
  const source = readFileSync(new URL("./workflow-task-authority.ts", import.meta.url), "utf8");
  assert.match(source, /select status, lease_epoch::text as "leaseEpoch", lease_owner as "leaseOwner" from workflow_runs where id = \$1::uuid for update/u);
  assert.match(source, /run\.leaseOwner === input\.workerId[\s\S]+set lease_expires_at = now\(\)/u);
  assert.match(source, /lease_epoch = lease_epoch \+ 1/u);
  assert.match(storageFunction("./workflow-task-outcomes.ts", "completeWorkflowTask"), /sibling\.id <> \$4::uuid[\s\S]+sibling\.status in \('leased', 'running'\)/u);
  assert.match(source, /assertActiveTaskFence[\s\S]+wt\.lease_generation=\$3::bigint[\s\S]+wr\.status in \('leased','running'\)/u);
  assert.match(source, /renewWorkflowTaskLease[\s\S]+update workflow_tasks[\s\S]+lease_generation = \$4::bigint[\s\S]+select 1 from workflow_runs[\s\S]+status in \('leased','running'\)/u);
  assert.doesNotMatch(source, /assertActiveTaskFence[\s\S]{0,500}wr\.lease_epoch=\$3::bigint/u);
});

function compactSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, " ").slice(0, 220);
}

test("migration creates memory_nodes and memory_edges tables", () => {
  const source = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /CREATE TABLE IF NOT EXISTS memory_nodes[\s\S]+project_id text NOT NULL[\s\S]+node_id text NOT NULL[\s\S]+node_type text NOT NULL CHECK \(node_type IN \('goal','task','evidence','artifact','decision','action','result'\)\)[\s\S]+UNIQUE\(project_id, node_id\)/u
  );
  assert.match(
    source,
    /CREATE TABLE IF NOT EXISTS memory_edges[\s\S]+project_id text NOT NULL[\s\S]+from_node text NOT NULL[\s\S]+to_node text NOT NULL[\s\S]+edge_type text NOT NULL CHECK \(edge_type IN \('decomposes','supports','produces','decided_by','executes','leads_to','supersedes','relates'\)\)[\s\S]+UNIQUE\(project_id, from_node, to_node, edge_type\)/u
  );
  assert.match(source, /CREATE INDEX IF NOT EXISTS memory_nodes_project_type_idx/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS memory_edges_project_from_idx/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS memory_edges_project_to_idx/u);
});
