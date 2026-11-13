import {QUEUE_SHARED_ITEM_LIMIT,type QueueAdmissionPressure} from '../../../../packages/workflow-engine/src/queue-coordinator-plan.js';

export interface QueueAdmissionWorkerEvidence {
 status?:string;lastHeartbeatAt?:string;providerIds?:unknown;concurrency?:number;
}

/** Scheduling evidence only. Existing owners remain untouched; this bounds how
 * many new reservations a planner may add during the current pass. */
export function deriveQueueAdmissionPressure(input:{storageReady:boolean;activeTasks:number;reservedItems?:number;verifierReserved?:boolean;worker:QueueAdmissionWorkerEvidence;circuits?:Record<string,{openedAt?:number}>|null;circuitCooldownMs?:number;now?:number}):QueueAdmissionPressure{
 const now=input.now??Date.now(),heartbeat=Date.parse(String(input.worker.lastHeartbeatAt??''));
 const fresh=Number.isFinite(heartbeat)&&now-heartbeat>=0&&now-heartbeat<=15_000;
 const providers=Array.isArray(input.worker.providerIds)?input.worker.providerIds.filter(value=>typeof value==='string'&&value.trim()):[];
 const concurrency=Number.isInteger(input.worker.concurrency)?Math.max(0,Math.min(input.worker.concurrency!,32)):0;
 const active=Number.isInteger(input.activeTasks)?Math.max(0,input.activeTasks):Number.POSITIVE_INFINITY;
 const cooldown=Math.max(1_000,Math.min(input.circuitCooldownMs??60_000,3_600_000)),circuits=input.circuits===undefined?{}:input.circuits;
 const circuitEvidenceValid=circuits!==null&&typeof circuits==='object';
 const availableProviders=circuitEvidenceValid?providers.filter(provider=>{const state=circuits[`${provider}:tier-default`];return !state?.openedAt||now-state.openedAt>=cooldown;}):[];
 const unavailableProviders=providers.filter(provider=>!availableProviders.includes(provider));
 const workerReady=input.worker.status==='running'&&fresh,providerReady=workerReady&&availableProviders.length>0;
 const reservations=input.reservedItems===undefined?0:Number.isInteger(input.reservedItems)&&input.reservedItems>=0?input.reservedItems:Number.POSITIVE_INFINITY;
 const free=providerReady?Math.max(0,Math.min(concurrency-active,QUEUE_SHARED_ITEM_LIMIT-Math.max(active,reservations))):0;
 // Restrictive reservations inhibit admission; they do not assert working activity.
 return {storageReady:input.storageReady,providerReady,verifierReady:providerReady&&free>0&&!input.verifierReserved,newItemLimit:input.storageReady?Math.min(QUEUE_SHARED_ITEM_LIMIT,free):0,availableProviders,unavailableProviders};
}
