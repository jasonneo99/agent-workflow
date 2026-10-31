import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "./client.js";
import { projectIdentitySchemaSql, previewProjectIdentityPlanOnClient, applyProjectIdentityPlanOnClient,
  revertProjectIdentityEventOnClient, registerProjectIdentityScope, verifyProjectIdentityEventsOnClient } from "./project-identity.js";

test("PostgreSQL identity reconciliation preserves scopes/history and rejects stale or unsafe links", async () => {
  await withClient(async c => {
    await c.query("begin");
    try {
      const schema=`identity_test_${randomUUID().replaceAll("-","")}`;
      await c.query(`create schema ${schema}`);
      await c.query(`set local search_path to ${schema},public`);
      await c.query(`create table projects(id uuid primary key,name text,root_uri text unique,profile text,config jsonb);
        create table workflow_runs(id uuid primary key,project_id uuid references projects(id),policy_snapshot jsonb,status text);
        create table action_approvals(id uuid primary key,run_id uuid references workflow_runs(id),payload jsonb);
        create table action_receipts(id uuid primary key,run_id uuid references workflow_runs(id),receipt_hash text);
        create table work_intents(project_id uuid,owner text,token bigint)`);
      await c.query(projectIdentitySchemaSql);
      const primary=randomUUID(), clone=randomUUID(), vendor=randomUUID(), unrelated=randomUUID();
      for (const [id,root] of [[primary,"/synthetic/product"],[clone,"/other/product"],
        [vendor,"/synthetic/fleet/vendor/product"],[unrelated,"/synthetic/unrelated"]]) {
        await c.query("insert into projects values($1,'same-name',$2,'local',$3)",[id,root,JSON.stringify({allow:[id],scope:root})]);
        await registerProjectIdentityScope(c,id);
      }
      const run=randomUUID();
      await c.query("insert into workflow_runs values($1,$2,$3,'blocked')",[run,vendor,JSON.stringify({only:vendor})]);
      await c.query("insert into action_approvals values($1,$2,$3)",[randomUUID(),run,JSON.stringify({exactProject:vendor})]);
      await c.query("insert into action_receipts values($1,$2,'immutable-hash')",[randomUUID(),run]);
      await c.query("insert into work_intents values($1,'fixture-owner',7)",[vendor]);
      const history=async()=>{const rows=[];for(const table of ["projects","workflow_runs","action_approvals","action_receipts","work_intents"]) rows.push((await c.query(`select * from ${table} order by 1`)).rows);return JSON.stringify(rows);};
      const before=await history();
      const plan=await previewProjectIdentityPlanOnClient(c,primary,[{projectId:clone,kind:"checkout"},{projectId:vendor,kind:"vendor"}]);
      await assert.rejects(applyProjectIdentityPlanOnClient(c,{...plan,scopes:[]},"operator","tampered plan"),/content changed/);
      const event=await applyProjectIdentityPlanOnClient(c,plan,"fixture-operator","Explicitly reviewed same product; no inherited permission");
      assert.equal(await history(),before,"Original project IDs, configs, run ownership, approvals, intents and receipt hashes must be byte-equivalent");
      const bindings=(await c.query("select project_id,identity_id,kind from project_identity_locations")).rows;
      assert.equal(bindings.find(r=>r.project_id===vendor).identity_id,primary);
      assert.equal(bindings.find(r=>r.project_id===vendor).kind,"vendor");
      assert.equal(bindings.find(r=>r.project_id===unrelated).identity_id,unrelated,"Same name is not identity proof");
      assert.equal(await verifyProjectIdentityEventsOnClient(c),true);
      await registerProjectIdentityScope(c,clone);
      assert.equal((await c.query("select identity_id from project_identity_locations where project_id=$1",[clone])).rows[0].identity_id,primary,"Reindexing cannot undo a reviewed association");
      await assert.rejects(previewProjectIdentityPlanOnClient(c,primary,[{projectId:vendor,kind:"checkout"}]),/read-only/);
      await assert.rejects(previewProjectIdentityPlanOnClient(c,clone,[{projectId:primary,kind:"checkout"}]),/canonical identity/);
      await assert.rejects(applyProjectIdentityPlanOnClient(c,plan,"operator","stale replay"),/changed after preview/);
      await c.query("savepoint aba");
      await c.query("update project_identity_locations set generation=generation+2 where project_id=$1",[clone]);
      await assert.rejects(revertProjectIdentityEventOnClient(c,event,"operator","ABA rollback"),/stale rollback/);
      await c.query("rollback to savepoint aba");
      await revertProjectIdentityEventOnClient(c,event,"fixture-operator","Verify additive rollback");
      const second=await applyProjectIdentityPlanOnClient(c,await previewProjectIdentityPlanOnClient(c,primary,
        [{projectId:clone,kind:"checkout"},{projectId:vendor,kind:"vendor"}]),"operator","Repeat identical association after rollback");
      await assert.rejects(revertProjectIdentityEventOnClient(c,event,"operator","Original-event ABA rollback"),/stale rollback/);
      await revertProjectIdentityEventOnClient(c,second,"operator","Revert latest association only");
      assert.equal(await history(),before);
      assert.equal((await c.query("select identity_id from project_identity_locations where project_id=$1",[vendor])).rows[0].identity_id,vendor);
      assert.equal(await verifyProjectIdentityEventsOnClient(c),true);
      await assert.rejects(revertProjectIdentityEventOnClient(c,event,"operator","repeat rollback"),/stale rollback/);
      const stale=await previewProjectIdentityPlanOnClient(c,primary,[{projectId:clone,kind:"checkout"}]);
      await c.query("update projects set config=$2 where id=$1",[clone,JSON.stringify({changed:true})]);
      await assert.rejects(applyProjectIdentityPlanOnClient(c,stale,"operator","policy changed"),/changed after preview/);
      // New worktree registrations reuse an actual common-root binding but retain scope.
      const worktree=randomUUID();
      await c.query("insert into projects values($1,'product','/synthetic/worktree','local','{}')",[worktree]);
      await registerProjectIdentityScope(c,worktree,"/synthetic/product");
      assert.equal((await c.query("select identity_id from project_identity_locations where project_id=$1",[worktree])).rows[0].identity_id,primary);
      assert.equal(await verifyProjectIdentityEventsOnClient(c),true);
      await c.query("update project_identity_events set reason='tampered' where id=$1",[event]);
      assert.equal(await verifyProjectIdentityEventsOnClient(c),false);
    } finally { await c.query("rollback"); }
  });
});

test("PostgreSQL concurrent reconciliation fences a waiting stale rollback",async()=>{
  await withClient(async first=>withClient(async second=>{
    const schema=`identity_concurrency_${randomUUID().replaceAll("-","")}`;
    try {
      await first.query(`create schema ${schema}`);
      for(const c of [first,second]) await c.query(`set search_path to ${schema},public`);
      await first.query("create table projects(id uuid primary key,name text,root_uri text unique,profile text,config jsonb)");
      await first.query(projectIdentitySchemaSql);
      const target=randomUUID(),source=randomUUID();
      await first.query("begin");
      for(const [id,root] of [[target,"/synthetic/main"],[source,"/synthetic/clone"]]) {
        await first.query("insert into projects values($1,'fixture',$2,'local','{}')",[id,root]);
        await registerProjectIdentityScope(first,id);
      }
      const event=await applyProjectIdentityPlanOnClient(first,await previewProjectIdentityPlanOnClient(first,target,
        [{projectId:source,kind:"checkout"}]),"operator","Initial fixture association");
      await first.query("commit");
      await first.query("begin");
      await first.query("select project_id from project_identity_locations where project_id=$1 for update",[source]);
      await second.query("begin");
      const pid=(await second.query("select pg_backend_pid() as pid")).rows[0].pid;
      const rollback=revertProjectIdentityEventOnClient(second,event,"operator","Concurrent stale rollback")
        .then(()=>null,error=>error as Error);
      const deadline=Date.now()+3000;
      while(!(await first.query("select exists(select 1 from pg_locks where pid=$1 and not granted) as waiting",[pid])).rows[0].waiting) {
        if(Date.now()>deadline) throw new Error("Rollback did not wait for the location fence");
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      await applyProjectIdentityPlanOnClient(first,await previewProjectIdentityPlanOnClient(first,target,
        [{projectId:source,kind:"checkout"}]),"operator","Newer association while rollback waits");
      await first.query("commit");
      const error=await rollback;
      assert.match(error?.message??"",/stale rollback/);
      await second.query("rollback");
      assert.equal((await first.query("select identity_id from project_identity_locations where project_id=$1",[source])).rows[0].identity_id,target);
      assert.equal(await verifyProjectIdentityEventsOnClient(first),true);
    } finally {
      for(const c of [first,second]) {await c.query("rollback");await c.query("reset search_path");}
      assert.match(schema,/^identity_concurrency_[a-f0-9]{32}$/u);
      await first.query(`drop schema if exists ${schema} cascade`);
    }
  }));
});
