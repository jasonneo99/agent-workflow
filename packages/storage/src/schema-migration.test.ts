import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {coordinatedSchemaMigration} from './schema-migration.js';

async function clients<T>(fn: (a: pg.Client,b: pg.Client)=>Promise<T>) {
  const connectionString=process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'Run through the isolated database harness');
  assert.match(new URL(connectionString).pathname, /agentflow_suite_test_/);
  const a=new pg.Client({connectionString}),b=new pg.Client({connectionString});
  await a.connect();await b.connect();
  try {return await fn(a,b);} finally {await a.end();await b.end();}
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('real database migrators serialize and release session locks',async()=>clients(async(a,b)=>{
  const order:string[]=[];
  const first=coordinatedSchemaMigration(a,async c=>{order.push('first');await c.query('select pg_sleep(0.2)');order.push('first done');});
  await pause(50);
  const second=coordinatedSchemaMigration(b,async()=>{order.push('second');});
  await Promise.all([first,second]);
  assert.deepEqual(order,['first','first done','second']);
  assert.equal((await b.query('select pg_try_advisory_lock(109512,1) as locked')).rows[0].locked,true);
  await b.query('select pg_advisory_unlock(109512,1)');
}));

test('real reader conflict retries without aborting or killing the reader',async()=>clients(async(a,b)=>{
  const table='migration_fixture_'+randomUUID().replaceAll('-','');
  await a.query(`create table ${table}(id int)`);
  try {
    await a.query('begin');await a.query(`select * from ${table}`);
    const migration=coordinatedSchemaMigration(b,c=>c.query(`alter table ${table} add column evidence text`));
    await pause(450);await a.query('commit');await migration;
    assert.equal((await b.query("select count(*)::int as n from information_schema.columns where table_name=$1 and column_name='evidence'",[table])).rows[0].n,1);
    assert.equal((await a.query('select 1 as still_alive')).rows[0].still_alive,1);
  } finally {await a.query('rollback');await a.query(`drop table ${table}`);}
}));

test('permanent migration errors propagate and restore connection settings',async()=>clients(async(a,b)=>{
  await a.query("set lock_timeout='3s'");
  await assert.rejects(coordinatedSchemaMigration(a,c=>c.query('select missing_migration_function()')), {code:'42883'});
  assert.equal((await a.query('show lock_timeout')).rows[0].lock_timeout,'3s');
  assert.equal((await b.query('select pg_try_advisory_lock(109512,1) as locked')).rows[0].locked,true);
  await b.query('select pg_advisory_unlock(109512,1)');
}));

test('an unchanged live reader exhausts bounded retries with no schema effects',async()=>clients(async(a,b)=>{
  const table='migration_fixture_'+randomUUID().replaceAll('-','');
  await a.query(`create table ${table}(id int)`);
  try {
    await a.query('begin');await a.query(`select * from ${table}`);
    await assert.rejects(coordinatedSchemaMigration(b,c=>c.query(`alter table ${table} add column evidence text`)),{code:'55P03'});
    await a.query('commit');
    assert.equal((await b.query("select count(*)::int as n from information_schema.columns where table_name=$1 and column_name='evidence'",[table])).rows[0].n,0);
  } finally {await a.query('rollback');await a.query(`drop table ${table}`);}
}));
