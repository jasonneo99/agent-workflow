import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { databaseUrl } from "../../../packages/storage/src/client.js";
import { enqueueRunNotification, runNotificationOutboxSchemaSql, engineEventConsumerSchemaSql } from "../../../packages/storage/src/run-notifications.js";
import { readOriginEvents, acknowledgeOriginEvent, type OriginEvent } from "./origin-event-stream.js";

test("engine-wide push replays offline events and independently acknowledges consumers", { timeout: 20000 }, async () => {
  const schema = `engine_events_test_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: databaseUrl() });
  const children: ReturnType<typeof spawn>[] = [];
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`); created = true;
    await client.query(`SET search_path TO ${schema}`);
    await client.query("CREATE TABLE projects(id uuid PRIMARY KEY, root_uri text)");
    await client.query("CREATE TABLE workflow_runs(id uuid PRIMARY KEY,project_id uuid,requester_channel text,evaluation_metadata jsonb)");
    await client.query("CREATE TABLE run_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid,channel text,kind text,title text,body text,status text DEFAULT 'pending',created_at timestamptz DEFAULT now(),delivered_at timestamptz)");
    await client.query(runNotificationOutboxSchemaSql);
    await client.query(engineEventConsumerSchemaSql);
    const a = randomUUID(), b = randomUUID();
    await client.query("INSERT INTO projects VALUES($1,'/synthetic-a'),($2,'/synthetic-b')",[a,b]);
    await client.query("INSERT INTO workflow_runs VALUES($1,$1,'studio',$3),($2,$2,'cli','{}')",[a,b,{originClient:"studio",originTaskId:"conversation-a"}]);
    const first = await enqueueRunNotification(client,{runId:a,kind:"progress",eventKey:"stage:1",title:"Synthetic stage"});
    const second = await enqueueRunNotification(client,{runId:b,kind:"completed",eventKey:"run:1",title:"Synthetic result"});
    const all = await readOriginEvents(client,{consumer:"studio-test"});
    assert.deepEqual(all.map(e=>e.id),[first,second]);
    assert.equal(all[1].taskId,null,"non-Studio tasks are included");
    assert.equal((await readOriginEvents(client,{consumer:"studio-test",project:"/synthetic-a"})).length,1);
    assert.equal(await acknowledgeOriginEvent(client,{consumer:"studio-test",project:"/wrong"},all[0]),false);
    assert.equal(await acknowledgeOriginEvent(client,{consumer:"studio-test"},all[0]),true);
    assert.equal((await readOriginEvents(client,{consumer:"muse-test"})).length,2,"Studio ACK cannot consume Muse events");
    assert.equal((await client.query("SELECT acknowledged_at FROM run_notifications WHERE id=$1",[first])).rows[0].acknowledged_at,null,"subscriber ACK is not origin receipt");
    const connection = new URL(databaseUrl()); connection.searchParams.set("options",`-c search_path=${schema}`);
    const module = new URL("./origin-event-stream.ts",import.meta.url).href;
    const start = () => {
      const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",`const {runOriginEventStream}=await import(${JSON.stringify(module)}); await runOriginEventStream({consumer:"live-test"});`],{env:{...process.env,DATABASE_URL:connection.href},stdio:["pipe","pipe","pipe"]});
      children.push(child);
      const events: OriginEvent[]=[]; let buffer="";
      child.stdout!.on("data",chunk=>{buffer+=chunk;const lines=buffer.split("\n");buffer=lines.pop()!;for(const line of lines) if(line)events.push(JSON.parse(line));});
      return {child,events};
    };
    async function until(check:()=>boolean|Promise<boolean>):Promise<void>{ for(let i=0;i<100;i++){if(await check())return;await delay(25);}assert.fail("Expected real event/ACK within 2.5 seconds, not the 30-second reconciliation interval"); }
    const live=start(); await until(()=>live.events.length===2);
    // Kill only our synthetic consumer before ACK: durable replay must survive.
    const exit=once(live.child,"exit");live.child.kill("SIGKILL");await exit;
    const restarted=start();await until(()=>restarted.events.length===2);
    restarted.child.stdin!.write(JSON.stringify({type:"ack",id:first,runId:a,taskId:"wrong"})+"\n");
    await delay(50);
    assert.equal((await readOriginEvents(client,{consumer:"live-test"})).length,2);
    for(const e of restarted.events.slice()) restarted.child.stdin!.write(JSON.stringify({type:"ack",id:e.id,runId:e.runId,taskId:e.taskId})+"\n");
    await until(async()=> (await readOriginEvents(client,{consumer:"live-test"})).length===0);
    // A commit wakes LISTEN immediately; no polling timer needs to elapse.
    await client.query("BEGIN");
    const fresh=await enqueueRunNotification(client,{runId:b,kind:"progress",eventKey:"stage:2",title:"Commit-time push"});
    await delay(50);assert.ok(!restarted.events.some(e=>e.id===fresh));
    await client.query("COMMIT");
    await until(()=>restarted.events.some(e=>e.id===fresh));
    const third=restarted.events.find(e=>e.id===fresh)!;
    restarted.child.stdin!.write(JSON.stringify({type:"ack",id:third.id,runId:third.runId,taskId:third.taskId})+"\n");
    await until(async()=> (await readOriginEvents(client,{consumer:"live-test"})).length===0);
    assert.equal((await readOriginEvents(client,{consumer:"muse-test"})).length,3);
  } finally {
    for(const child of children) if(child.exitCode===null && child.signalCode===null){const exit=once(child,"exit");child.kill("SIGKILL");await exit;}
    if(created) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }
});
