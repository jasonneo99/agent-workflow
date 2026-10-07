import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

// Synthetic reproduction only. Never accepts the live DATABASE_URL.
function isolatedUrl(): string {
  const value = process.env.RECEIPT_LINKAGE_DISPOSABLE_URL;
  assert(value, 'Disposable URL required');
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/receipt_linkage');
  assert(url.port && url.port !== '15432', 'Refuse default storage port');
  process.env.DATABASE_URL = value;
  return value;
}
function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `Docker setup/cleanup failure: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
async function main(): Promise<void> {
  if (process.argv[2] === '--verify-child') {
    isolatedUrl();
    const { Command } = await import('commander');
    const { registerSystemCommands } = await import('../apps/cli/src/commands/system.js');
    const program = new Command();
    // verify-receipts does not use CliContext; no runtime.env loading occurs.
    registerSystemCommands(program, {} as Parameters<typeof registerSystemCommands>[1]);
    await program.parseAsync(process.argv.slice(3), { from: 'user' });
    return;
  }
  const name = `receipt-linkage-${randomUUID()}`;
  let started = false;
  let client: pg.Client | undefined;
  try {
    docker(['run', '--pull=never', '--rm', '-d', '--name', name,
      '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=synthetic', '-e', 'POSTGRES_PASSWORD=synthetic',
      '-e', 'POSTGRES_DB=receipt_linkage', 'pgvector/pgvector:pg16']);
    started = true;
    const binding = docker(['port', name, '5432/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    assert(match, 'Unexpected disposable port binding');
    process.env.RECEIPT_LINKAGE_DISPOSABLE_URL = `postgres://synthetic:synthetic@127.0.0.1:${match[1]}/receipt_linkage`;
    const connectionString = isolatedUrl();
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
      try { await candidate.connect(); client = candidate; ready = true; break; }
      catch { await candidate.end().catch(() => {}); await delay(250); }
    }
    assert(ready && client, 'Disposable PostgreSQL unavailable; not a reproduction');
    await client.query(await readFile(new URL('../infra/init.sql', import.meta.url), 'utf8'));
    await client.query("insert into agents(id,display_name,category,source_path,definition) values ('workflow-orchestrator','Synthetic orchestrator','operations','synthetic','{}')");
    const { recordRunAction, resumeWorkflowRunFromCheckpoint } = await import('../packages/storage/src/postgres.js');
    async function run(): Promise<string> {
      const result = await client!.query("insert into workflow_runs(status,task,autonomy) values ('queued','Synthetic receipt linkage reproduction','0') returning id::text");
      return result.rows[0].id as string;
    }
    async function append(runId: string, label: string): Promise<void> {
      await recordRunAction({ runId, agentId: 'workflow-orchestrator', actionType: `synthetic_${label}`, target: label,
        summary: `Synthetic ${label}`, artifactKind: 'synthetic_linkage', artifactContent: { label }, idempotencyKey: label });
      await delay(20);
    }
    function verify(runId: string) {
      const args = ['--import', 'tsx', fileURLToPath(import.meta.url), '--verify-child', 'verify-receipts', '--run', runId, '--json'];
      const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH, DATABASE_URL: connectionString, RECEIPT_LINKAGE_DISPOSABLE_URL: connectionString, DEFAULT_MODEL_PROVIDER: 'mock' } });
      assert(!child.error && child.signal === null, 'Child execution failure; not a reproduction');
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.runId, runId);
      const evidence = { executable: 'node', args: args.map((arg) => arg === fileURLToPath(import.meta.url) ? 'scripts/receipt-linkage-reproduction.ts' : arg), exitCode: child.status, stdout: child.stdout, stderr: child.stderr, result };
      console.log(JSON.stringify({ kind: 'cli_observation', ...evidence }));
      return evidence;
    }
    const control = await run();
    await append(control, 'control_a');
    await append(control, 'control_b');
    const green = verify(control);
    assert.equal(green.exitCode, 0);
    assert.equal(green.result.valid, true);
    assert.equal(green.result.checked, 2);
    const mixed = await run();
    await append(mixed, 'a');
    await resumeWorkflowRunFromCheckpoint({ runId: mixed, actor: 'synthetic', reason: 'Synthetic unchained receipt' });
    await delay(20);
    await append(mixed, 'b');
    const rows = (await client.query(`select id::text,run_id::text,agent_id,action_type,target,summary,metadata::text,created_at,prev_hash,receipt_hash,metadata_serialization_version from action_receipts where run_id=$1 order by created_at asc limit 4`, [mixed])).rows;
    console.log(JSON.stringify({ kind: 'bounded_synthetic_receipts', rows }));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].action_type, 'synthetic_a');
    assert.equal(rows[1].action_type, 'checkpoint_resume_requested');
    assert.equal(rows[1].receipt_hash, null);
    assert.equal(rows[2].action_type, 'synthetic_b');
    const red = verify(mixed);
    assert.equal(red.exitCode, 1);
    assert.equal(red.result.valid, false);
    assert.equal(red.result.checked, 1);
    assert.equal(red.result.brokenAt, 1);
    assert.equal(red.result.reason, `prev_hash mismatch at index 1: expected ${rows[0].receipt_hash.slice(0, 12)}..., got GENESIS...`);
    assert.equal(rows[2].prev_hash, 'GENESIS', 'Writer reset must be independently observed');
    assert.notEqual(rows[2].prev_hash, rows[0].receipt_hash);
    // Negative controls alter only disposable synthetic rows, after original evidence capture.
    await client.query("update action_receipts set summary='Synthetic tampering' where run_id=$1 and action_type='synthetic_control_b'", [control]);
    const tamper = verify(control);
    assert.equal(tamper.exitCode, 1);
    assert.equal(tamper.result.valid, false);
    assert.equal(tamper.result.brokenAt, 1);
    assert.match(tamper.result.reason, /^receipt_hash mismatch/);
    await client.query('update action_receipts set metadata_serialization_version=999 where run_id=$1', [control]);
    const unsupported = verify(control);
    assert.equal(unsupported.exitCode, 1);
    assert.equal(unsupported.result.valid, false);
    assert.equal(unsupported.result.brokenAt, 0);
    assert.match(unsupported.result.reason, /unsupported serialization version/);
    console.log(JSON.stringify({ kind: 'receipt_linkage_reproduction', reproduced: true, productVerified: false,
      verifierFailureRow: rows[1].id, writerResetRow: rows[2].id,
      assertions: ['chained-only control', 'exact mixed-history CLI red', 'persisted writer GENESIS reset', 'tampering rejection', 'unsupported-version rejection'],
      unmeasured: ['tied timestamps', 'concurrent writers', 'legacy semantics', 'repair green', 'full suite/typecheck/build/boundary'] }));
  } finally {
    await client?.end();
    if (started) docker(['stop', '--time', '1', name]);
  }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ kind: 'reproduction_failure', reproduced: false, reason: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
