import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { loadAgentRecords, loadWorkflowRecords } from "../../agent-registry/src/loaders.js";
import { createWorkflowRun, migrateStorage, seedRegistry, verifyRunReceiptChain } from "./postgres.js";
import { contextInfluence } from "../../project-evidence/src/influence.js";
import { readContextInfluence } from "./context-influence.js";
import { providerWithInfluence } from "../../workflow-engine/src/context-influence.js";
import type { StageExecutionInput } from "../../model-providers/src/types.js";

test("plan and provider attribution persist in the canonical receipt chain, isolate projects and roll back malformed plans", {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const base=process.env.TEST_DATABASE_URL!,name=`influence_test_${randomUUID().replaceAll("-","")}`;
  const admin=new pg.Client({connectionString:base});await admin.connect();
  const previous=process.env.DATABASE_URL;
  try{
    await admin.query(`create database ${name}`);
    const url=new URL(base);url.pathname=`/${name}`;process.env.DATABASE_URL=url.href;
    const client=new pg.Client({connectionString:url.href});await client.connect();
    try{
      await client.query(await fs.readFile(new URL("../../../infra/init.sql",import.meta.url),"utf8"));
      await migrateStorage();
      const agents=await loadAgentRecords(process.cwd()),workflows=await loadWorkflowRecords(process.cwd());
      await seedRegistry(agents,workflows);
      const workflow=workflows.find(value=>value.value.id==="build-feature")!.value;
      const text="Synthetic compiled context",influence=contextInfluence(text,[{kind:"file",key:"requirements.md",includedHash:"hash",observedAt:null,freshness:"unverified",confidence:"recorded",target:{type:"file",value:"requirements.md"}}]);
      const options={projectName:"Synthetic",projectRootUri:"/synthetic/influence",projectProfile:"custom",projectConfig:{},workflow,task:"Explain synthetic attribution",autonomy:"1",policyProfile:"local",policySnapshot:{},policySnapshotHash:"hash",compiledBrief:text,compiledBriefMetadata:{contextInfluence:influence}};
      const run=await createWorkflowRun(options);
      let view=await readContextInfluence(options.projectRootUri,run.runId);
      assert.equal(view.receipts.length,1);assert.equal(view.receipts[0].phase,"plan");assert.equal(view.receipts[0].metadata.contextHash,influence.contextHash);
      const task=(await client.query("select id::text,agent_id,stage_id from workflow_tasks where run_id=$1 order by id limit 1",[run.runId])).rows[0];
      const stage={runId:run.runId,taskId:task.id,stageId:task.stage_id,agentId:task.agent_id,agentName:"Synthetic",agentPrompt:"Synthetic instructions",workflowId:workflow.id,workflowTask:options.task,stageGoal:"Explain",projectConfig:{} as never,compiledBrief:text,priorReceipts:[]} as StageExecutionInput;
      const wrapped=providerWithInfluence({id:"mock",executeStage:async()=>({summary:"Synthetic result",artifact:{verified:false}})});
      const output=await wrapped.executeStage(stage);
      assert.match(String(output.artifact.contextInfluenceReceiptUri),/^db:\/\//);
      view=await readContextInfluence(options.projectRootUri,run.runId);
      assert.deepEqual(view.receipts.map(receipt=>receipt.phase),["plan","provider_input","provider_result"]);
      assert.equal((await readContextInfluence("/synthetic/other",run.runId)).receipts.length,0);
      assert.equal((await verifyRunReceiptChain(run.runId)).valid,true);
      const before=(await client.query("select count(*)::int as n from workflow_runs")).rows[0].n;
      await assert.rejects(createWorkflowRun({...options,task:"Invalid attribution",compiledBriefMetadata:{contextInfluence:{...influence,contextHash:"forged"}}}),/Invalid compiled context influence/);
      assert.equal((await client.query("select count(*)::int as n from workflow_runs")).rows[0].n,before);
    }finally{await client.end();}
  }finally{
    if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()",[name]);
    await admin.query(`drop database if exists ${name}`);await admin.end();
  }
});
