import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workerHostKeyFingerprint, type TrustedWorkerHost, type WorkerHeartbeatTrustStore } from "./worker-heartbeat-attestation.js";

export type WorkerHostRegistryAction = "enroll" | "rotate" | "disable";

export type WorkerHostRegistryPlan = {
  schemaVersion: 1;
  id: string;
  action: WorkerHostRegistryAction;
  hostId: string;
  generatedAt: string;
  beforeDigest: string;
  afterDigest: string;
  keyFingerprint: string | null;
  allowedRuntimeBuildDigests: string[];
  expiresAt: string | null;
  overlapUntil: string | null;
  next: WorkerHeartbeatTrustStore;
  warnings: string[];
};

export type WorkerHostRegistryReceipt = Omit<WorkerHostRegistryPlan,"next">&{
  actor:string;
  appliedAt:string;
  registryPath:string;
};

function stable(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stable).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value:unknown):string{return createHash("sha256").update(stable(value)).digest("hex");}
function validTime(value:string|null|undefined,label:string,now:number):string|null{
  if(!value)return null;
  const parsed=Date.parse(value);if(!Number.isFinite(parsed)||parsed<=now)throw new Error(`${label} must be a future ISO timestamp.`);
  return new Date(parsed).toISOString();
}

export function buildWorkerHostRegistryPlan(input:{
  store:WorkerHeartbeatTrustStore;
  action:WorkerHostRegistryAction;
  hostId:string;
  publicKey?:string;
  allowedRuntimeBuildDigests?:string[];
  expiresAt?:string|null;
  overlapUntil?:string|null;
  now?:Date;
}):WorkerHostRegistryPlan{
  const now=input.now??new Date();const nowMs=now.getTime();
  const hostId=input.hostId.trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(hostId))throw new Error("hostId must be a bounded stable fleet identity.");
  const current=input.store.hosts.filter(host=>host.hostId===hostId);
  const active=current.filter(host=>host.enabled!==false&&(!host.expiresAt||Date.parse(host.expiresAt)>nowMs)&&(!host.retiresAt||Date.parse(host.retiresAt)>nowMs));
  const expiresAt=validTime(input.expiresAt,"expiresAt",nowMs);
  const overlapUntil=validTime(input.overlapUntil,"overlapUntil",nowMs);
  const builds=[...new Set((input.allowedRuntimeBuildDigests??[]).map(value=>value.trim()).filter(Boolean))].sort();
  let keyFingerprint:string|null=null;
  let hosts=[...input.store.hosts];
  const warnings:string[]=[];
  if(input.action==="disable"){
    if(!current.length)throw new Error(`Cannot disable unknown fleet host ${hostId}.`);
    hosts=hosts.map(host=>host.hostId===hostId?{...host,enabled:false}:host);
  }else{
    if(!input.publicKey)throw new Error(`${input.action} requires an operator-supplied public key.`);
    keyFingerprint=workerHostKeyFingerprint(input.publicKey);
    if(input.action==="enroll"&&active.length)throw new Error(`Fleet host ${hostId} is already enrolled; use rotate.`);
    if(input.action==="rotate"&&!active.length)throw new Error(`Cannot rotate fleet host ${hostId} without an active registered key.`);
    if(input.action==="rotate"){
      if(!overlapUntil)throw new Error("rotate requires overlapUntil so in-flight signed heartbeats have a bounded transition window.");
      hosts=hosts.map(host=>host.hostId===hostId&&host.enabled!==false?{...host,retiresAt:overlapUntil}:host);
    }
    const replacement:TrustedWorkerHost={hostId,publicKey:input.publicKey,keyFingerprint,enabled:true,registeredAt:now.toISOString(),expiresAt,retiresAt:null,allowedRuntimeBuildDigests:builds};
    hosts=[...hosts.filter(host=>!(host.hostId===hostId&&host.keyFingerprint===keyFingerprint)),replacement];
    if(!builds.length)warnings.push("No runtime build allowlist was supplied; the signature still binds the reported build, but any signed build from this key is eligible.");
  }
  const next:WorkerHeartbeatTrustStore={schemaVersion:1,hosts:hosts.sort((a,b)=>`${a.hostId}:${a.keyFingerprint}`.localeCompare(`${b.hostId}:${b.keyFingerprint}`))};
  const beforeDigest=digest(input.store);const afterDigest=digest(next);
  const id=digest({action:input.action,hostId,beforeDigest,afterDigest,generatedAt:now.toISOString()}).slice(0,24);
  return {schemaVersion:1,id,action:input.action,hostId,generatedAt:now.toISOString(),beforeDigest,afterDigest,keyFingerprint,allowedRuntimeBuildDigests:builds,expiresAt,overlapUntil,next,warnings};
}

export async function applyWorkerHostRegistryPlan(input:{plan:WorkerHostRegistryPlan;registryPath:string;receiptPath:string;actor:string}):Promise<WorkerHostRegistryReceipt>{
  const registryPath=path.resolve(input.registryPath);const receiptPath=path.resolve(input.receiptPath);
  let current:WorkerHeartbeatTrustStore={schemaVersion:1,hosts:[]};
  try{current=JSON.parse(await fs.readFile(registryPath,"utf8")) as WorkerHeartbeatTrustStore;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(digest(current)!==input.plan.beforeDigest)throw new Error("Fleet host registry changed after preview; generate a new plan.");
  await fs.mkdir(path.dirname(registryPath),{recursive:true});
  const temporary=`${registryPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary,`${JSON.stringify(input.plan.next,null,2)}\n`,{encoding:"utf8",mode:0o600});
  await fs.rename(temporary,registryPath);
  const {next:_next,...evidence}=input.plan;
  const receipt:WorkerHostRegistryReceipt={...evidence,actor:input.actor,appliedAt:new Date().toISOString(),registryPath};
  await fs.mkdir(path.dirname(receiptPath),{recursive:true});
  await fs.appendFile(receiptPath,`${JSON.stringify(receipt)}\n`,{encoding:"utf8",mode:0o600});
  return receipt;
}
