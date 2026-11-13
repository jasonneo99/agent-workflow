import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signWorkerHeartbeat, workerHostKeyFingerprint, type WorkerHeartbeatTrustStore } from "./worker-heartbeat-attestation.js";
import { ingestRemoteWorkerHeartbeat, loadRemoteWorkerHeartbeatHealth } from "./worker-heartbeat-ingestion.js";

function signed(sequence:string,now:Date){
  const keys=generateKeyPairSync("ed25519");const privateKey=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();const publicKey=keys.publicKey.export({type:"spki",format:"pem"}).toString();
  const heartbeat:Record<string,unknown>={workerId:"worker-a:worker",pid:123,status:"running",lastHeartbeatAt:now.toISOString(),executionCapabilities:["python-pycompile-glob-v1"]};
  heartbeat.attestation=signWorkerHeartbeat({heartbeat,hostId:"worker-a",privateKey,runtimeBuildDigest:"approved",sequence,now});
  const trustStore:WorkerHeartbeatTrustStore={schemaVersion:1,hosts:[{hostId:"worker-a",publicKey,keyFingerprint:workerHostKeyFingerprint(publicKey),allowedRuntimeBuildDigests:["approved"]}]};
  return {heartbeat,trustStore};
}

test("remote ingestion verifies before atomically advancing durable cursor",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"agentflow-heartbeat-ingest-"));const cursorPath=path.join(dir,"cursor.state");const now=new Date("2026-10-26T20:00:00Z");const value=signed("10",now);
  const first=await ingestRemoteWorkerHeartbeat({heartbeat:value.heartbeat,trustStore:value.trustStore,heartbeatDir:dir,cursorPath,now:new Date(now.getTime()+1000)});
  assert.equal(first.accepted,true);assert.equal(first.deliveryLagMs,1000);assert.equal(first.workerFreshnessMs,1000);
  const cursor=JSON.parse(await readFile(cursorPath,"utf8"));assert.equal(cursor.hosts["worker-a"].sequence,"10");
  const repeated=await ingestRemoteWorkerHeartbeat({heartbeat:value.heartbeat,trustStore:value.trustStore,heartbeatDir:dir,cursorPath,now:new Date(now.getTime()+2000)});assert.equal(repeated.idempotent,true);
});

test("durable cursor rejects rollback and same-sequence conflicting evidence",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"agentflow-heartbeat-replay-"));const cursorPath=path.join(dir,"cursor.state");const now=new Date("2026-10-26T20:00:00Z");const current=signed("10",now);
  await ingestRemoteWorkerHeartbeat({heartbeat:current.heartbeat,trustStore:current.trustStore,heartbeatDir:dir,cursorPath,now});
  const older={...current.heartbeat,attestation:{...(current.heartbeat.attestation as object),sequence:"9"}};
  await assert.rejects(()=>ingestRemoteWorkerHeartbeat({heartbeat:older,trustStore:current.trustStore,heartbeatDir:dir,cursorPath,now}),/rejected/);
  const conflicting={...current.heartbeat,attestation:{...(current.heartbeat.attestation as object),payloadDigest:"different"}};
  await assert.rejects(()=>ingestRemoteWorkerHeartbeat({heartbeat:conflicting,trustStore:current.trustStore,heartbeatDir:dir,cursorPath,now}),/rejected|conflicts/);
});

test("unsigned and unknown-host ingestion never writes last-good state",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"agentflow-heartbeat-untrusted-"));const cursorPath=path.join(dir,"cursor.state");
  await assert.rejects(()=>ingestRemoteWorkerHeartbeat({heartbeat:{workerId:"remote"},trustStore:{schemaVersion:1,hosts:[]},heartbeatDir:dir,cursorPath}),/requires a signed/);
  const now=new Date();const value=signed("1",now);await assert.rejects(()=>ingestRemoteWorkerHeartbeat({heartbeat:value.heartbeat,trustStore:{schemaVersion:1,hosts:[]},heartbeatDir:dir,cursorPath,now}),/unknown-host/);
  await assert.rejects(()=>readFile(cursorPath,"utf8"),/ENOENT/);
});

test("fleet health separates delivery lag, worker freshness, trust and key lifecycle",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"agentflow-heartbeat-health-"));const cursorPath=path.join(dir,"cursor.state");const now=new Date("2026-10-26T20:00:00Z");const value=signed("7",now);
  await ingestRemoteWorkerHeartbeat({heartbeat:value.heartbeat,trustStore:value.trustStore,heartbeatDir:dir,cursorPath,now:new Date(now.getTime()+1_000)});
  value.trustStore.hosts.push({hostId:"worker-b",publicKey:value.trustStore.hosts[0]!.publicKey,keyFingerprint:value.trustStore.hosts[0]!.keyFingerprint,enabled:false});
  const health=await loadRemoteWorkerHeartbeatHealth({trustStore:value.trustStore,heartbeatDir:dir,cursorPath,now:new Date(now.getTime()+2_000)});
  assert.deepEqual(health.map(item=>[item.hostId,item.state,item.keyLifecycle]),[["worker-a","trusted","current"],["worker-b","disabled","disabled"]]);
  assert.equal(health[0]?.deliveryLagMs,1_000);assert.equal(health[0]?.workerFreshnessMs,2_000);assert.equal(health[0]?.transportFreshnessMs,1_000);
});
