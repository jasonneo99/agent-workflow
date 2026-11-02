import { ProviderExecutionError } from "../../model-providers/src/fallback.js";
import assert from "node:assert/strict";
import test from "node:test";
import { providerWithInfluence, stageContextInfluence } from "./context-influence.js";
import type { StageExecutionInput, ModelProvider } from "../../model-providers/src/types.js";
import type { recordRunAction } from "../../storage/src/postgres.js";
const input = (): StageExecutionInput => ({runId:"run",taskId:"task",stageId:"plan",agentId:"test",agentName:"Test",agentPrompt:"Instructions",workflowId:"fixture",workflowTask:"Explain",stageGoal:"Explain",projectConfig:{} as never,compiledBrief:"Exact stage context",priorReceipts:[],priorStageArtifacts:[],fileReads:[{path:"src/main.ts",content:"old",truncated:false,sha256:"source-old"}]});
test("every provider invocation is preceded by durable attribution and returned results link to it", async () => {
  const writes: Parameters<typeof recordRunAction>[0][]=[];
  let calls=0;
  const provider: ModelProvider={id:"mock",executeStage:async()=>{assert.equal(writes.at(-1)?.actionType,"context_influence");calls++;return {summary:"done",artifact:{contextInfluenceReceiptUri:"forged"}};}};
  const record: typeof recordRunAction=async value=>{writes.push(value);return `db://input/${writes.length}`;};
  const wrapped=providerWithInfluence(provider,record);
  const a=await wrapped.executeStage(input());
  const next=input();next.fileReads![0].content="new";next.fileReads![0].sha256="source-new";
  const b=await wrapped.executeStage(next);
  assert.equal(calls,2);assert.equal(writes.length,4);assert.equal(a.artifact.contextInfluenceReceiptUri,"db://input/1");assert.equal(b.artifact.contextInfluenceReceiptUri,"db://input/3");
  assert.notEqual((writes[0].artifactContent.references as {includedHash:string}[])[0].includedHash,(writes[2].artifactContent.references as {includedHash:string}[])[0].includedHash);
  assert.notEqual(writes[0].idempotencyKey,writes[2].idempotencyKey);
  assert.equal(writes[1].artifactContent.influenceReceiptUri,"db://input/1");
});
test("receipt failure prevents provider invocation; provider failure retains its input receipt", async () => {
  let calls=0;const provider: ModelProvider={id:"mock",executeStage:async()=>{calls++;throw new Error("provider failed");}};
  await assert.rejects(providerWithInfluence(provider,async()=>{throw new Error("storage unavailable");}).executeStage(input()),(error:unknown)=>error instanceof ProviderExecutionError&&error.kind==="configuration"&&error.message.includes("provider execution stopped"));assert.equal(calls,0);
  let writes=0;await assert.rejects(providerWithInfluence(provider,async()=>{writes++;return "db://input";}).executeStage(input()),/provider failed/);assert.equal(writes,1);assert.equal(calls,1);
});
test("stage artifacts retain stable attribution across JSONB key ordering", () => {
  const a=input(),b=input();a.priorStageArtifacts=[{stageId:"prior",agentId:"test",summary:"s",artifact:{a:1,b:2}}];b.priorStageArtifacts=[{stageId:"prior",agentId:"test",summary:"s",artifact:{b:2,a:1}}];
  assert.equal(stageContextInfluence(a).references.find(ref=>ref.kind==="stage_artifact")?.includedHash,stageContextInfluence(b).references.find(ref=>ref.kind==="stage_artifact")?.includedHash);
});
