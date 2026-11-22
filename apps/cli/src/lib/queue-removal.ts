import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {withClient} from '../../../../packages/storage/src/client.js';
import {activeQueueRunPredicateSql} from '../../../../packages/storage/src/queue-lineage.js';

export type FailedCardRemoval={runId:string;taskDigest:string};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
/** A human reviews this exact visible list; later arrivals are not swept in. */
export function failedCardRemovalSnapshot(items:readonly {runId:string;runStatus:string;task:string;failedRemovalCandidates?:FailedCardRemoval[]}[]):FailedCardRemoval[]{
 const candidates=items.filter(item=>item.runStatus==='failed').flatMap(item=>item.failedRemovalCandidates??[{runId:item.runId,taskDigest:acceptanceDigest(item.task)}]);
 return [...new Map(candidates.map(item=>[item.runId,item])).values()];
}
/** Family membership selects what the human reviews, never execution authority.
 * Already withdrawn/dismissed history is excluded from the approved selection. */
export async function withFailedCardRemovalCandidates<T extends {runId:string;runStatus:string;familyAttempts?:Array<{id:string;status:string}>}>(items:T[]):Promise<Array<T&{failedRemovalCandidates:FailedCardRemoval[]}>>{
 const members=new Map(items.filter(item=>item.runStatus==='failed').map(item=>[item.runId,
  (item.familyAttempts??[{id:item.runId,status:item.runStatus}]).filter(attempt=>attempt.status==='failed').map(attempt=>attempt.id)]));
 const ids=[...new Set([...members.values()].flat())];
 if(ids.length>1000)throw Error('Failed family selection exceeds its review bound; select fewer cards.');
 const rows=ids.length?await withClient(async c=>(await c.query<{id:string;task:string}>(`select r.id::text,r.task from workflow_runs r
  where r.id=any($1::uuid[]) and r.status='failed' and ${activeQueueRunPredicateSql('r')}`,[ids])).rows):[];
 const candidates=new Map(rows.map(row=>[row.id,{runId:row.id,taskDigest:acceptanceDigest(row.task)}]));
 return items.map(item=>({...item,failedRemovalCandidates:(members.get(item.runId)??[]).flatMap(id=>candidates.has(id)?[candidates.get(id)!]:[])}));
}
export function parseFailedCardRemovals(value:string):FailedCardRemoval[]{
 if(value.length>160_000)throw Error('Failed-card selection is too large.');
 let items:unknown;try{items=JSON.parse(value);}catch{throw Error('Refresh the queue to review an exact failed-card selection.');}
 if(!Array.isArray(items)||!items.length||items.length>1000||new Set(items.map(item=>item?.runId)).size!==items.length
  ||items.some(item=>!item||typeof item!=='object'||typeof item.runId!=='string'||typeof item.taskDigest!=='string'||!uuid.test(item.runId)||!/^[a-f0-9]{64}$/u.test(item.taskDigest)
   ||Object.keys(item).some(key=>!['runId','taskDigest'].includes(key))))throw Error('Invalid exact failed-card selection.');
 return items as FailedCardRemoval[];
}
/** Each withdrawal remains individually governed; one refusal never rolls back
 * an already receipted removal or silently hides an unresolved item. */
export async function removeReviewedFailedCards(items:readonly FailedCardRemoval[],remove:(item:FailedCardRemoval)=>Promise<{ok:boolean;error?:string}>){
 const removed:string[]=[],refused:Array<{runId:string;reason:string}>=[];
 for(const item of items)try{const result=await remove(item);if(result.ok)removed.push(item.runId);else refused.push({runId:item.runId,reason:result.error??'Removal was refused.'});}
 catch(error){refused.push({runId:item.runId,reason:error instanceof Error?error.message:'Removal was refused.'});}
 return {removed,refused};
}
