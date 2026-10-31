import fs from "node:fs/promises";
import path from "node:path";
import { verifyWorkerHeartbeat, type WorkerHeartbeatAttestation, type WorkerHeartbeatTrustStore } from "./worker-heartbeat-attestation.js";

export type RemoteHeartbeatCursor = { sequence:string;payloadDigest:string;acceptedAt:string };
export type RemoteHeartbeatCursorState = { schemaVersion:1;hosts:Record<string,RemoteHeartbeatCursor> };
export type RemoteHeartbeatIngestionResult = {
  accepted:boolean;
  idempotent:boolean;
  hostId:string;
  sequence:string;
  heartbeatPath:string;
  cursorPath:string;
  acceptedAt:string;
  deliveryLagMs:number|null;
  workerFreshnessMs:number|null;
};

export type RemoteWorkerHeartbeatHealth = {
  hostId:string;
  state:"trusted"|"not-delivered"|"transport-delayed"|"worker-stale"|"untrusted"|"disabled";
  trustState:string;
  trustReason:string;
  sequence:string|null;
  acceptedAt:string|null;
  transportFreshnessMs:number|null;
  deliveryLagMs:number|null;
  workerFreshnessMs:number|null;
  runtimeBuildDigest:string|null;
  activeKeys:number;
  keyLifecycle:"current"|"expiring"|"expired"|"disabled";
  nextKeyExpiryAt:string|null;
};

async function atomicJson(filePath:string,value:unknown):Promise<void>{
  await fs.mkdir(path.dirname(filePath),{recursive:true});
  const temporary=`${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{encoding:"utf8",mode:0o600});
  await fs.rename(temporary,filePath);
}

async function readCursor(filePath:string):Promise<RemoteHeartbeatCursorState>{
  try{const value=JSON.parse(await fs.readFile(filePath,"utf8")) as RemoteHeartbeatCursorState;return value?.schemaVersion===1&&value.hosts&&typeof value.hosts==="object"?value:{schemaVersion:1,hosts:{}};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return {schemaVersion:1,hosts:{}};}
}

function boundedHostFile(hostId:string):string{return hostId.replace(/[^A-Za-z0-9._-]/g,"_").slice(0,128);}

export async function ingestRemoteWorkerHeartbeat(input:{
  heartbeat:Record<string,unknown>;
  trustStore:WorkerHeartbeatTrustStore;
  heartbeatDir:string;
  cursorPath:string;
  now?:Date;
}):Promise<RemoteHeartbeatIngestionResult>{
  const attestation=input.heartbeat.attestation as WorkerHeartbeatAttestation|undefined;
  if(!attestation||typeof attestation.hostId!=="string"||typeof attestation.sequence!=="string")throw new Error("Remote worker heartbeat requires a signed host attestation.");
  const state=await readCursor(input.cursorPath);const prior=state.hosts[attestation.hostId];
  const latest=prior?new Map([[attestation.hostId,prior.sequence]]):undefined;
  const trust=verifyWorkerHeartbeat({heartbeat:input.heartbeat,trustStore:input.trustStore,now:input.now,latestSequenceByHost:latest});
  if(!trust.trusted)throw new Error(`Remote worker heartbeat rejected (${trust.state}): ${trust.reason}`);
  if(prior&&BigInt(attestation.sequence)===BigInt(prior.sequence)){
    if(attestation.payloadDigest!==prior.payloadDigest)throw new Error("Remote worker heartbeat sequence conflicts with previously accepted payload evidence.");
    return result(false,true,attestation,input.heartbeat,input.heartbeatDir,input.cursorPath,prior.acceptedAt,input.now??new Date());
  }
  const acceptedAt=(input.now??new Date()).toISOString();
  const heartbeatPath=path.join(input.heartbeatDir,`remote-${boundedHostFile(attestation.hostId)}.json`);
  await atomicJson(heartbeatPath,input.heartbeat);
  state.hosts[attestation.hostId]={sequence:attestation.sequence,payloadDigest:attestation.payloadDigest,acceptedAt};
  await atomicJson(input.cursorPath,state);
  return result(true,false,attestation,input.heartbeat,input.heartbeatDir,input.cursorPath,acceptedAt,input.now??new Date());
}

function result(accepted:boolean,idempotent:boolean,attestation:WorkerHeartbeatAttestation,heartbeat:Record<string,unknown>,heartbeatDir:string,cursorPath:string,acceptedAt:string,now:Date):RemoteHeartbeatIngestionResult{
  const issuedAt=Date.parse(attestation.issuedAt);const workerAt=typeof heartbeat.lastHeartbeatAt==="string"?Date.parse(heartbeat.lastHeartbeatAt):Number.NaN;
  return {accepted,idempotent,hostId:attestation.hostId,sequence:attestation.sequence,heartbeatPath:path.join(heartbeatDir,`remote-${boundedHostFile(attestation.hostId)}.json`),cursorPath,acceptedAt,deliveryLagMs:Number.isFinite(issuedAt)?Math.max(0,now.getTime()-issuedAt):null,workerFreshnessMs:Number.isFinite(workerAt)?Math.max(0,now.getTime()-workerAt):null};
}

export async function loadRemoteWorkerHeartbeatHealth(input:{trustStore:WorkerHeartbeatTrustStore;heartbeatDir:string;cursorPath:string;now?:Date}):Promise<RemoteWorkerHeartbeatHealth[]>{
  const now=input.now??new Date();const nowMs=now.getTime();const cursor=await readCursor(input.cursorPath);
  const hostIds=[...new Set([...input.trustStore.hosts.map(host=>host.hostId),...Object.keys(cursor.hosts)])].sort();
  return Promise.all(hostIds.map(async hostId=>{
    const keys=input.trustStore.hosts.filter(host=>host.hostId===hostId);const enabled=keys.filter(key=>key.enabled!==false);
    const expiries=enabled.flatMap(key=>[key.expiresAt,key.retiresAt]).filter((value):value is string=>Boolean(value)).map(value=>Date.parse(value)).filter(Number.isFinite).sort((a,b)=>a-b);
    const nextExpiry=expiries.find(value=>value>nowMs)??null;const active=enabled.filter(key=>(!key.expiresAt||Date.parse(key.expiresAt)>nowMs)&&(!key.retiresAt||Date.parse(key.retiresAt)>nowMs));
    const keyLifecycle:RemoteWorkerHeartbeatHealth["keyLifecycle"]=!enabled.length?"disabled":!active.length?"expired":nextExpiry!==null&&nextExpiry-nowMs<=7*24*60*60*1000?"expiring":"current";
    const prior=cursor.hosts[hostId];
    if(!prior)return {hostId,state:keyLifecycle==="disabled"?"disabled":"not-delivered",trustState:"missing",trustReason:"No remote heartbeat has been accepted for this registered host.",sequence:null,acceptedAt:null,transportFreshnessMs:null,deliveryLagMs:null,workerFreshnessMs:null,runtimeBuildDigest:null,activeKeys:active.length,keyLifecycle,nextKeyExpiryAt:nextExpiry===null?null:new Date(nextExpiry).toISOString()};
    let heartbeat:Record<string,unknown>;
    try{heartbeat=JSON.parse(await fs.readFile(path.join(input.heartbeatDir,`remote-${boundedHostFile(hostId)}.json`),"utf8")) as Record<string,unknown>;}catch{return {hostId,state:"untrusted",trustState:"missing-last-good",trustReason:"Durable cursor exists but the last-good heartbeat is unavailable.",sequence:prior.sequence,acceptedAt:prior.acceptedAt,transportFreshnessMs:Math.max(0,nowMs-Date.parse(prior.acceptedAt)),deliveryLagMs:null,workerFreshnessMs:null,runtimeBuildDigest:null,activeKeys:active.length,keyLifecycle,nextKeyExpiryAt:nextExpiry===null?null:new Date(nextExpiry).toISOString()};}
    const trust=verifyWorkerHeartbeat({heartbeat,trustStore:input.trustStore,now});const attestation=heartbeat.attestation as WorkerHeartbeatAttestation|undefined;
    const issuedAt=attestation?Date.parse(attestation.issuedAt):Number.NaN;const workerAt=typeof heartbeat.lastHeartbeatAt==="string"?Date.parse(heartbeat.lastHeartbeatAt):Number.NaN;const acceptedAt=Date.parse(prior.acceptedAt);
    const transportFreshnessMs=Number.isFinite(acceptedAt)?Math.max(0,nowMs-acceptedAt):null;const deliveryLagMs=Number.isFinite(issuedAt)&&Number.isFinite(acceptedAt)?Math.max(0,acceptedAt-issuedAt):null;const workerFreshnessMs=Number.isFinite(workerAt)?Math.max(0,nowMs-workerAt):null;
    const staleAfter=Math.max((typeof heartbeat.intervalMs==="number"?heartbeat.intervalMs:2_000)*3,15_000);
    let state:RemoteWorkerHeartbeatHealth["state"]=!trust.trusted&&trust.state!=="expired"?"untrusted":workerFreshnessMs!==null&&workerFreshnessMs>staleAfter?"worker-stale":deliveryLagMs!==null&&deliveryLagMs>15_000?"transport-delayed":keyLifecycle==="disabled"?"disabled":"trusted";
    return {hostId,state,trustState:trust.state,trustReason:trust.reason,sequence:prior.sequence,acceptedAt:prior.acceptedAt,transportFreshnessMs,deliveryLagMs,workerFreshnessMs,runtimeBuildDigest:attestation?.runtimeBuildDigest??null,activeKeys:active.length,keyLifecycle,nextKeyExpiryAt:nextExpiry===null?null:new Date(nextExpiry).toISOString()};
  }));
}
