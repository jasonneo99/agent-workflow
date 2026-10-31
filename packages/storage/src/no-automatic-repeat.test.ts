import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { automaticRecoveryAdmissionFenceSql, automaticRecoveryWrapperReason, automaticRepeatForbidden } from "./no-automatic-repeat.js";

test("automatic catch-all queue wrappers are refused without rejecting narrow repairs or direct product requests", () => {
  const broad = 'Resolve every currently failed or blocked Agent Workflow queue item for this project. Source items: synthetic evidence.';
  for (const source of ['server-orchestration', 'workflow-supervisor-repair', 'blocked-run-repair', 'workflow-root-repair', 'queue-partner-recovery']) {
    const task = source.includes('repair') && source !== 'queue-partner-recovery'
      ? `Repair supervised Agent Workflow run synthetic.\n\nOriginal task: ${broad}` : broad;
    assert.match(automaticRecoveryWrapperReason({ task, evaluationMetadata: { source } })!, /Catch-all queue recovery wrappers/u);
  }
  for (const task of ['Implement a bounded terminal backend', 'Fix all failed tests in the terminal module', 'Diagnose one blocked original outcome', 'Document queue recovery.\nExample: Resolve every failed queue item']) {
    assert.equal(automaticRecoveryWrapperReason({ task, evaluationMetadata: { source: 'server-orchestration' } }), null);
  }
  assert.equal(automaticRecoveryWrapperReason({ task: broad }), null, 'A direct human request is not silently recast as automatic repair');
});

test("prospective storage fence rejects stale producers, preserves history and matches client admission", {
  skip: process.env.AGENTFLOW_ADMISSION_FENCE_PG_TEST !== '1'
}, async () => {
  const {default:pg}=await import('pg');
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url && /^\/agentflow_(?:controlled_plan|suite)_test_[a-f0-9]{32}$/u.test(new URL(url).pathname), 'Only an explicitly disposable UUID database is a test target');
  const c=new pg.Client({connectionString:url});await c.connect();
  try {
    await c.query('begin');
    await c.query('create schema admission_fixture;set local search_path to admission_fixture;create table workflow_runs(id serial primary key,task text not null,evaluation_metadata jsonb not null)');
    const broad='Resolve every currently failed or blocked Agent Workflow queue item for this project.';
    await c.query('insert into workflow_runs(task,evaluation_metadata) values($1,$2)',[broad,{source:'server-orchestration'}]);
    const before=(await c.query('select * from workflow_runs')).rows;
    // A separate installed fence must not be replaced or disabled.
    await c.query(`create function existing_guard() returns trigger language plpgsql as $$begin return NEW;end$$;
      create trigger existing_guard before insert on workflow_runs for each row execute function existing_guard()`);
    await c.query(automaticRecoveryAdmissionFenceSql);
    await c.query(automaticRecoveryAdmissionFenceSql);
    let denied=0;
    for(const source of ['server-orchestration','workflow-supervisor-repair','blocked-run-repair','workflow-root-repair','queue-partner-recovery',undefined]) {
      for(const original of [broad,'Fix all blocked workflows','Repair every queue item','Fix all failed tests in terminal','Implement terminal','Document recovery.\nExample: Resolve every queue item',` \n${broad}\n `]) {
        const task=source?.includes('repair')&&source!=='queue-partner-recovery'?`Repair supervised run synthetic.\n\nOriginal task: ${original}`:original;
        const metadata=source?{source}:{};
        await c.query('savepoint candidate');
        if(automaticRecoveryWrapperReason({task,evaluationMetadata:metadata})) {
          await assert.rejects(c.query('insert into workflow_runs(task,evaluation_metadata) values($1,$2)',[task,metadata]),(error:any)=>error.code==='23514'&&error.constraint==='workflow_runs_no_automatic_queue_wrapper');
          denied++;await c.query('rollback to candidate');
        } else await c.query('insert into workflow_runs(task,evaluation_metadata) values($1,$2)',[task,metadata]);
        await c.query('release candidate');
      }
    }
    assert.equal(denied,20);
    assert.deepEqual((await c.query('select * from workflow_runs where id=$1',[before[0]!.id])).rows,before,'Historical broad wrapper remains unchanged');
    assert.deepEqual((await c.query("select tgname,tgenabled,tgtype from pg_trigger where tgrelid='workflow_runs'::regclass and not tgisinternal order by tgname")).rows,[
      {tgname:'existing_guard',tgenabled:'O',tgtype:7},{tgname:'workflow_runs_no_automatic_queue_wrapper',tgenabled:'O',tgtype:7}
    ]);
    assert.ok(readFileSync(new URL('./postgres.ts',import.meta.url),'utf8').includes('await client.query(automaticRecoveryAdmissionFenceSql)'));
  } finally {await c.query('rollback');await c.end();}
});

test("one-shot authority is enforced by metadata and the independent-review workflow identity", () => {
  for (const run of [{ evaluationMetadata: { noAutomaticRepeat: true } },
    { evaluationMetadata: { kind: "explicit-independent-acceptance-review" } },
    { evaluationMetadata: { source: "explicit-independent-acceptance-review" } },
    { workflowId: "explicit-independent-acceptance-review" }]) assert.equal(automaticRepeatForbidden(run), true);
  assert.equal(automaticRepeatForbidden({ workflowId: "ordinary", evaluationMetadata: { noAutomaticRepeat: false } }), false);
  assert.equal(automaticRepeatForbidden({}), false);
});

test("approval resume refuses one-shot cloning while preserving the executed action response", () => {
  const source = readFileSync(new URL("../../../apps/cli/src/lib/builders-shared.ts", import.meta.url), "utf8");
  const resume = source.slice(source.indexOf("export async function resumeBlockedRunAfterResolvedApprovals"), source.indexOf("export function selectWorkflowAgents"));
  assert.ok(resume.indexOf("automaticRepeatForbidden(details.run)") < resume.indexOf("resumeWorkflowRunFromCheckpoint({"));
  assert.match(resume, /return \{ resumedTasks: 0, holdReason: noAutomaticRepeatReason \}/u);
  const approval = source.slice(source.indexOf("export async function approveAndExecuteAction"), source.indexOf("export function buildArchivedArtifactContent"));
  assert.ok(approval.indexOf("await executeApprovedAction") < approval.indexOf("await resumeBlockedRunAfterResolvedApprovals"));
  assert.match(approval, /resumed\.holdReason/u);
});
