import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('actual worker releases only its current task generation and preserves successors', async t => {
  if (process.env.AGENTFLOW_CLAIM_RELEASE_FIXTURE !== '1') {
    const env: NodeJS.ProcessEnv = {...process.env, AGENTFLOW_CLAIM_RELEASE_FIXTURE: '1'};
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--test', fileURLToPath(import.meta.url)],
      {env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024});
    console.log(child.stdout + child.stderr);
    assert.equal(child.status, 0, 'Inspect the actual-worker claim-release fixture output');
    return;
  }
  const api = await import('../../storage/src/postgres.js');
  const {withClient} = await import('../../storage/src/client.js');
  const {projectConfigSchema, workflowSchema} = await import('../../agent-registry/src/schemas.js');
  await withClient(async c => assert.match((await c.query('select current_database() name')).rows[0].name, /^agentflow_suite_test_[a-f0-9]{32}$/u));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claim-release-fixture-')));
  t.after(async () => { await fs.rm(root, {recursive: true, force: true}); });
  await withClient(async c => {
    await c.query("insert into agents(id,display_name,category,source_path,definition) values('implementation-agent','Synthetic implementer','test','synthetic','{}'),('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}') on conflict(id) do nothing");
  });
  const create = async (label: string, parallel = false) => {
    const projectRoot = path.join(root, label); await fs.mkdir(projectRoot);
    const workflowId = 'claim-release-' + randomUUID();
    const stages = [0, ...(parallel ? [1] : [])].map(index => ({id: 'inspect-' + index, agent: 'implementation-agent',
      goal: 'Inspect synthetic ownership', output: 'evidence', ...(parallel ? {parallel_group: 'pair', depends_on: []} : {})}));
    const workflow = workflowSchema.parse({id: workflowId, name: 'Synthetic claim release', description: 'Bounded ownership control',
      lead: 'implementation-agent', execution: {kind: 'read-only'}, stages});
    await withClient(async c => { await c.query("insert into workflows(id,name,source_path,definition) values($1,$2,'synthetic',$3)", [workflowId, workflow.name, JSON.stringify(workflow)]); });
    const config = projectConfigSchema.parse({project: {name: 'Synthetic claim release', autonomy: 2}});
    const run = await api.createWorkflowRun({projectName: 'Synthetic claim release', projectRootUri: projectRoot, projectProfile: 'test',
      projectConfig: config, workflow, task: 'Inspect bounded synthetic ownership ' + label, autonomy: '2', policyProfile: 'local', policySnapshot: config, policySnapshotHash: '0'.repeat(64)});
    return {run, projectRoot, claim: async (workerId = 'synthetic-worker') => {
      const claim = await api.claimNextWorkflowTask({runId: run.runId, projectRootUri: projectRoot, workerId});
      assert.ok(claim); return claim;
    }};
  };
  const start = async (claim: any) => api.startWorkflowTask({taskId: claim.taskId, runId: claim.runId, workerId: claim.workerId, fencingToken: claim.fencingToken});
  const identity = (claim: any) => ({taskId: claim.taskId, runId: claim.runId, workerId: claim.workerId, fencingToken: claim.fencingToken});
  const snapshot = async (runId: string) => withClient(async c => ({
    run: (await c.query('select to_jsonb(r) value from workflow_runs r where id=$1', [runId])).rows[0].value,
    tasks: (await c.query('select to_jsonb(t) value from workflow_tasks t where run_id=$1 order by id', [runId])).rows.map(row => row.value),
    receipts: (await c.query('select to_jsonb(r) value from action_receipts r where run_id=$1 order by created_at,id', [runId])).rows.map(row => row.value),
    artifacts: (await c.query('select to_jsonb(a) value from artifacts a where run_id=$1 order by id', [runId])).rows.map(row => row.value)
  }));
  let supplied: any, providerCalls = 0;
  const replace = async (relative: string, overrides: Record<string, unknown>) => {
    const url = new URL(relative, import.meta.url).href, original = await import(url);
    t.mock.module(url, {namedExports: {...original, ...overrides}});
  };
  await replace('../../storage/src/postgres.js', {claimNextWorkflowTask: async (input: any) => {
    assert.equal(input.runId, supplied.runId); return supplied;
  }});
  await replace('../../runtime-root/src/index.js', {resolveLocalProjectPath: async (root: string) => ({localRootUri: root, localPathExists: false})});
  await replace('./stage-telemetry.js', {flushStageTelemetry: async () => {}});
  const forbidden = () => { providerCalls++; throw Error('Claim-release controls must not invoke a model'); };
  await replace('../../model-providers/src/index.js', {executeWithProviderFallback: forbidden, providerFromEnv: forbidden});
  const {runWorkerOnce} = await import('./executor.js');
  const unavailable = async (claim: any) => {
    supplied = claim; const excluded = new Set<string>();
    const result = await runWorkerOnce(1, {runId: claim.runId, workerId: claim.workerId, recoverExpiredLeases: false, unavailableProjectRootUris: excluded});
    assert.deepEqual(result, {claimed: 1, completed: 0, failed: 0, providerFailures: []});
    assert.ok(excluded.has(claim.projectRootUri));
  };
  const expire = async (claim: any) => withClient(async c => {
    // Fixture clock injection affects only exact synthetic rows in the guarded UUID database.
    await c.query("update workflow_tasks set lease_expires_at=now()-interval '1 second' where id=$1 and run_id=$2", [claim.taskId, claim.runId]);
    await c.query("update workflow_runs set lease_expires_at=now()-interval '1 second' where id=$1", [claim.runId]);
  });

  await t.test('stale worker A cannot release current worker B or append a release claim', async () => {
    const fixture = await create('successor'), old = await fixture.claim('synthetic-a'); await start(old);
    await expire(old);
    await api.requeueExpiredWorkflowTaskLeases({runId: old.runId, actor: 'synthetic-clock', reason: 'Synthetic expiry'});
    const current = await fixture.claim('synthetic-b'); await start(current);
    assert.equal(current.taskId, old.taskId); assert.notEqual(current.fencingToken, old.fencingToken);
    const before = await snapshot(old.runId); await unavailable(old);
    assert.deepEqual(await snapshot(old.runId), before);
  });
  await t.test('same-worker continuation has a new stage generation while the sibling retains its run epoch', async () => {
    const fixture = await create('same-worker', true), old = await fixture.claim(); await start(old);
    const sibling = await fixture.claim(); await start(sibling);
    const original = await snapshot(old.runId);
    await api.checkpointWorkflowTaskContinuation({...identity(old), agentId: old.agentId, continuation: {synthetic: true}, delaySeconds: 1});
    await new Promise(resolve => setTimeout(resolve, 1100));
    const current = await fixture.claim();
    assert.equal(current.taskId, old.taskId); assert.equal(BigInt(current.fencingToken), BigInt(old.fencingToken) + 1n);
    await start(current); await api.assertWorkflowTaskLease(identity(current));
    assert.equal(await api.renewWorkflowTaskLease(identity(current)), true);
    const before = await snapshot(old.runId);
    assert.equal(before.run.lease_epoch, original.run.lease_epoch);
    assert.notEqual(current.fencingToken, String(before.run.lease_epoch));
    await unavailable(old); assert.deepEqual(await snapshot(old.runId), before);
    await unavailable(current);
    const after = await snapshot(old.runId);
    assert.deepEqual(after.tasks.find((row: any) => row.id === sibling.taskId), before.tasks.find((row: any) => row.id === sibling.taskId));
    assert.equal(after.run.lease_owner, before.run.lease_owner); assert.equal(after.run.lease_epoch, before.run.lease_epoch);
    assert.equal(after.run.lease_expires_at, before.run.lease_expires_at);
    assert.equal(after.tasks.find((row: any) => row.id === current.taskId).status, 'queued');
  });
  await t.test('current leased owner releases once and diagnostic identity includes its stage fence', async () => {
    const fixture = await create('leased'), claim = await fixture.claim(), before = await snapshot(claim.runId);
    await unavailable(claim); const after = await snapshot(claim.runId);
    assert.equal(after.tasks[0].status, 'queued'); assert.equal(after.tasks[0].worker_id, null);
    assert.equal(after.run.lease_owner, null); assert.equal(after.run.lease_expires_at, null);
    assert.equal(after.receipts.length - before.receipts.length, 2);
    assert.equal(after.receipts.filter((row: any) => row.action_type === 'stage_requeued').length, 1);
    const diagnostic = after.artifacts.find((row: any) => row.kind === 'worker_capability');
    assert.equal(diagnostic.content.fencingToken, claim.fencingToken);
    assert.equal(diagnostic.content.idempotencyKey, `worker-project-unavailable-${claim.taskId}-${claim.workerId}-${claim.fencingToken}`);
    assert.equal(await api.requeueClaimedWorkflowTask(identity(claim)), false);
    await unavailable(claim); assert.deepEqual(await snapshot(claim.runId), after);
    const next = await fixture.claim(); assert.notEqual(next.fencingToken, claim.fencingToken);
    await unavailable(next);
    const diagnostics = (await snapshot(claim.runId)).artifacts.filter((row: any) => row.kind === 'worker_capability');
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(diagnostics.map((row: any) => row.content.fencingToken).sort(), [claim.fencingToken, next.fencingToken].sort());
  });
  await t.test('claim generation advances existing historical values independently of the run epoch', async () => {
    const fixture = await create('historical-generation');
    await withClient(async c => { await c.query('update workflow_tasks set lease_generation=7 where run_id=$1', [fixture.run.runId]); });
    const claim = await fixture.claim(); assert.equal(claim.fencingToken, '8'); await start(claim);
    assert.equal(await api.renewWorkflowTaskLease(identity(claim)), true);
    assert.notEqual(String((await snapshot(claim.runId)).run.lease_epoch), claim.fencingToken);
    await unavailable(claim); assert.equal((await snapshot(claim.runId)).run.lease_owner, null);
  });
  await t.test('concurrent duplicate releases commit exactly one receipt', async () => {
    const fixture = await create('duplicate'), claim = await fixture.claim(), before = await snapshot(claim.runId);
    assert.deepEqual((await Promise.all([api.requeueClaimedWorkflowTask(identity(claim)), api.requeueClaimedWorkflowTask(identity(claim))])).sort(), [false, true]);
    const after = await snapshot(claim.runId); assert.equal(after.receipts.length - before.receipts.length, 1);
  });
  await t.test('automatic expiry preserves a live sibling and same-worker reclaim advances its stage generation', async () => {
    const fixture = await create('parallel-expiry', true), old = await fixture.claim(); await start(old);
    const sibling = await fixture.claim(); await start(sibling);
    await withClient(async c => { await c.query("update workflow_tasks set lease_expires_at=now()-interval '1 second' where id=$1", [old.taskId]); });
    const before = await snapshot(old.runId);
    assert.deepEqual(await api.requeueExpiredWorkflowTaskLeases({runId: old.runId, actor: 'synthetic-clock', reason: 'Synthetic expired peer'}), {requeuedTasks: 1, affectedRuns: 1});
    const after = await snapshot(old.runId);
    assert.deepEqual(after.tasks.find((row: any) => row.id === sibling.taskId), before.tasks.find((row: any) => row.id === sibling.taskId));
    assert.equal(after.run.lease_owner, before.run.lease_owner); assert.equal(after.run.lease_epoch, before.run.lease_epoch);
    assert.equal(after.run.lease_expires_at, before.run.lease_expires_at);
    assert.equal(await api.renewWorkflowTaskLease(identity(sibling)), true);
    const current = await fixture.claim(); assert.equal(current.taskId, old.taskId);
    assert.equal(BigInt(current.fencingToken), BigInt(old.fencingToken) + 1n); await start(current);
    const reclaimed = await snapshot(old.runId); await unavailable(old);
    assert.deepEqual(await snapshot(old.runId), reclaimed);
  });
  await t.test('automatic expiry preserves an unexpired foreign run owner even without another active child', async () => {
    const fixture = await create('foreign-expiry'), claim = await fixture.claim(); await start(claim);
    await withClient(async c => {
      await c.query("update workflow_tasks set lease_expires_at=now()-interval '1 second' where id=$1", [claim.taskId]);
      await c.query("update workflow_runs set lease_owner='synthetic-new-owner' where id=$1", [claim.runId]);
    });
    const before = await snapshot(claim.runId);
    assert.equal((await api.requeueExpiredWorkflowTaskLeases({runId: claim.runId, actor: 'synthetic-clock', reason: 'Synthetic expired old owner'})).requeuedTasks, 1);
    const after = await snapshot(claim.runId);
    assert.equal(after.run.lease_owner, before.run.lease_owner); assert.equal(after.run.lease_epoch, before.run.lease_epoch);
    assert.equal(after.run.lease_expires_at, before.run.lease_expires_at);
  });
  await t.test('automatic expiry cannot rewrite a terminal run or its historical stages', async () => {
    const fixture = await create('terminal-expiry'), claim = await fixture.claim(); await start(claim);
    await expire(claim);
    await withClient(async c => { await c.query("update workflow_runs set status='completed' where id=$1", [claim.runId]); });
    const before = await snapshot(claim.runId);
    assert.deepEqual(await api.requeueExpiredWorkflowTaskLeases({runId: claim.runId, actor: 'synthetic-clock', reason: 'Synthetic terminal control'}), {requeuedTasks: 0, affectedRuns: 0});
    assert.deepEqual(await snapshot(claim.runId), before);
  });
  for (const locked of ['run', 'task']) {
    await t.test(`automatic expiry skips a locked ${locked} without a claim-order deadlock`, async () => {
      const fixture = await create('locked-' + locked), claim = await fixture.claim(); await start(claim); await expire(claim);
      const before = await snapshot(claim.runId);
      await withClient(async c => {
        await c.query('begin');
        try {
          if (locked === 'run') await c.query('select id from workflow_runs where id=$1 for update', [claim.runId]);
          else await c.query('select id from workflow_tasks where id=$1 for update', [claim.taskId]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Expiry waited on a claim lock')), 1500); });
            assert.deepEqual(await Promise.race([api.requeueExpiredWorkflowTaskLeases({runId: claim.runId, actor: 'synthetic-clock', reason: 'Synthetic lock control'}), timeout]), {requeuedTasks: 0, affectedRuns: 0});
          } finally { if (timer) clearTimeout(timer); }
        } finally { await c.query('rollback'); }
      });
      assert.deepEqual(await snapshot(claim.runId), before);
    });
  }
  for (const mode of ['wrong-run', 'wrong-worker', 'wrong-fence', 'expired-task', 'expired-run', 'wrong-run-owner', 'terminal-task', 'terminal-run']) {
    await t.test(`${mode} cannot mutate rows or receipts`, async () => {
      const fixture = await create(mode), claim = await fixture.claim(); await start(claim);
      const input = identity(claim);
      if (mode === 'wrong-run') input.runId = randomUUID();
      if (mode === 'wrong-worker') input.workerId = 'another-synthetic-worker';
      if (mode === 'wrong-fence') input.fencingToken = (BigInt(input.fencingToken) + 1n).toString();
      // These are fixture-state controls, never operational repairs or guard bypasses.
      await withClient(async c => {
        if (mode === 'expired-task') await c.query("update workflow_tasks set lease_expires_at=now()-interval '1 second' where id=$1", [claim.taskId]);
        if (mode === 'expired-run') await c.query("update workflow_runs set lease_expires_at=now()-interval '1 second' where id=$1", [claim.runId]);
        if (mode === 'wrong-run-owner') await c.query("update workflow_runs set lease_owner='another-synthetic-worker' where id=$1", [claim.runId]);
        if (mode === 'terminal-task') await c.query("update workflow_tasks set status='completed' where id=$1", [claim.taskId]);
        if (mode === 'terminal-run') await c.query("update workflow_runs set status='completed' where id=$1", [claim.runId]);
      });
      const before = await snapshot(claim.runId);
      assert.equal(await api.requeueClaimedWorkflowTask(input), false);
      assert.deepEqual(await snapshot(claim.runId), before);
    });
  }
  await t.test('revoked coordinator intent prevents release through the actual worker', async () => {
    const fixture = await create('coordinator'), owner = 'synthetic-coordinator';
    const intent = await api.acquireWorkIntent({projectId: fixture.run.projectId, owner, objective: 'Synthetic coordinator release', ttlSeconds: 300});
    const assignment = randomUUID();
    const fence = await withClient(async c => {
      const result = await c.query("insert into queue_coordinator_assignments(id,family_id,project_id,source_run_id,role,lane,owner,fingerprint,intent_fence,file_scopes,state,child_run_id) values($1,$2,$3,$4,'repair',1,$5,'synthetic',$6,'[]','running',$4) returning fence::text", [assignment, 'synthetic:' + fixture.run.runId, fixture.run.projectId, fixture.run.runId, owner, intent.fencingToken]);
      await c.query('update workflow_runs set evaluation_metadata=evaluation_metadata||$2::jsonb where id=$1', [fixture.run.runId, JSON.stringify({queueCoordinatorClaimId: assignment, queueCoordinatorFence: result.rows[0].fence})]);
      return result.rows[0].fence;
    });
    const claim = await fixture.claim(owner + ':' + fence); await start(claim);
    assert.equal(await api.releaseWorkIntent({projectId: fixture.run.projectId, owner, fencingToken: intent.fencingToken}), true);
    const before = await snapshot(claim.runId); await unavailable(claim);
    assert.deepEqual(await snapshot(claim.runId), before);
  });
  assert.equal(providerCalls, 0);
});
