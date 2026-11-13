import assert from 'node:assert/strict';
import test from 'node:test';
import {createQueuePartnerAdapter,createQueuePartnerRequestLedger,type PartnerRequestStore} from './queue-partner-queue.js';
import {processPartnerMessage,rankPartnerItems,type PartnerChatAdapter,type PartnerItem,type PartnerApproval,type PartnerProposal} from './queue-partner-chat.js';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',ra='33333333-3333-4333-8333-333333333333',rb='44444444-4444-4444-8444-444444444444',approvalId='55555555-5555-4555-8555-555555555555';
const message=(text:string,extra:Record<string,unknown>={})=>({message:text,conversationId:'whole-queue-chat',idempotencyKey:'request-one',history:[],...extra});
function ledgerFixture(){
 const rows=new Map<string,{status:'pending'|'completed'|'uncertain';token:string;receipt:Record<string,unknown>}>();let serial=0;
 const store:PartnerRequestStore={intent:async(_project,_key,action)=>action(),claim:async input=>{
  assert.equal(input.projectId,'queue-partner:request-routing');const old=rows.get(input.idempotencyKey);
  if(old)return {status:old.status==='pending'?'in_progress':old.status,receipt:old.receipt};
  const token=String(++serial);rows.set(input.idempotencyKey,{status:'pending',token,receipt:{}});return {status:'claimed',claimToken:token,receipt:{}};
 },finalize:async input=>{const row=rows.get(input.idempotencyKey);if(!row||row.token!==input.claimToken||row.status!=='pending')return false;row.status='completed';row.receipt=input.receipt;return true;}};
 return {store,rows};
}
function fixture(requests=ledgerFixture()){
 const items:PartnerItem[]=[{projectId:a,projectName:'Alpha',runId:ra,title:'Alpha check',status:'blocked',blocker:'Test failed',proposedFix:'Repair check',approvalCount:0},{projectId:b,projectName:'Beta',runId:rb,title:'Beta check',status:'failed',blocker:'Test failed',proposedFix:'Repair check',approvalCount:0}];
 const approvals:PartnerApproval[]=[];const proposals=new Map<string,PartnerProposal>(),denied=new Set<string>(),effects:string[]=[],claims:string[]=[];
 const owners=new Map<string,string>([[`run:${ra}`,a],[`run:${rb}`,b],[`approval:${approvalId}`,b]]);
 const scoped=(projectId:string):PartnerChatAdapter=>({
  canAct:()=>!denied.has(projectId),items:async()=>items.filter(i=>i.projectId===projectId),item:async id=>items.find(i=>i.projectId===projectId&&i.runId===id)??null,
  approvals:async id=>approvals.filter(p=>p.projectId===projectId&&p.runId===id),approval:async id=>approvals.find(p=>p.projectId===projectId&&p.id===id)??null,
  saveProposal:async p=>{assert.equal(p.projectId,projectId);proposals.set(p.id,p);owners.set(`proposal:${p.id}`,projectId);},proposal:async id=>proposals.get(id)??null,
  once:async(_key,_hash,runId,action)=>{assert.equal(owners.get(`run:${runId}`),projectId);claims.push(projectId);return action();},
  repair:async i=>{assert.equal(i.projectId,projectId);effects.push(`repair:${projectId}:${i.runId}`);return {status:'queued',text:'Scoped repair queued'};},
  stop:async i=>{assert.equal(i.projectId,projectId);effects.push(`stop:${projectId}:${i.runId}`);return {status:'requested',text:'Scoped stop recorded'};},
  approve:async p=>{assert.equal(p.projectId,projectId);effects.push(`approval:${projectId}:${p.id}`);return {status:'completed',text:'Scoped effect verified'};},converse:async()=> 'Scoped advice',
 });
 const adapter=createQueuePartnerAdapter({items:async()=>items,owner:async(kind,id)=>owners.get(`${kind}:${id}`)??null,adapter:async id=>[a,b].includes(id)?scoped(id):null,converse:async()=> 'Queue-wide advice only',onceMessage:createQueuePartnerRequestLedger(a,requests.store)});
 return {items,approvals,proposals,denied,effects,claims,owners,adapter,requests};
}
test('one project-free conversation lists and repairs items owned by different projects',async()=>{
 const f=fixture(),list=await processPartnerMessage(message('List items blockers and fixes'),f.adapter);
 assert.deepEqual(list.items.map(i=>i.projectName),['Beta','Alpha']);assert.match(list.text,/Alpha/);assert.match(list.text,/Beta/);assert.deepEqual(f.effects,[]);
 await processPartnerMessage(message('fix it',{runId:ra}),f.adapter);await processPartnerMessage(message('fix it',{runId:rb,idempotencyKey:'request-two'}),f.adapter);
 assert.deepEqual(f.effects,[`repair:${a}:${ra}`,`repair:${b}:${rb}`]);assert.deepEqual(f.claims,[a,b]);
});
test('stop uses the exact selected run owner and refuses a read-only owning project',async()=>{
 const f=fixture();f.items.forEach(item=>{item.status='running'});
 const result=await processPartnerMessage(message('Stop work',{runId:rb}),f.adapter);
 assert.equal(result.status,'requested');assert.deepEqual(f.effects,[`stop:${b}:${rb}`]);assert.deepEqual(f.claims,[b]);
 f.denied.add(a);
 assert.equal((await processPartnerMessage(message('Stop work',{runId:ra,idempotencyKey:'request-two'}),f.adapter)).status,'blocked');
 assert.deepEqual(f.effects,[`stop:${b}:${rb}`]);
});
test('pick next crosses projects and skips read-only owners without invoking effects there',async()=>{
 const f=fixture();f.denied.add(a);
 const reply=await processPartnerMessage(message('pick up the next blocked item'),f.adapter);
 assert.equal(reply.selectedRunId,rb);assert.deepEqual(f.effects,[`repair:${b}:${rb}`]);assert.deepEqual(f.claims,[b]);
 assert.equal((await processPartnerMessage(message('fix it',{runId:ra,idempotencyKey:'request-two'}),f.adapter)).status,'blocked');
});
test('delivery ranking finishes active and short remaining work before slower idle families',()=>{
 const ranked=rankPartnerItems([
  {projectId:a,runId:ra,title:'Long repair',status:'blocked',blocker:'Unique failure',proposedFix:'Repair',approvalCount:0,completedStages:1,totalStages:10,remainingStages:9,latestActivityAt:'2026-01-02T00:00:00Z'},
  {projectId:b,runId:rb,title:'Fast finish',status:'running',blocker:'',proposedFix:'Continue',approvalCount:0,completedStages:4,totalStages:5,remainingStages:1,latestActivityAt:'2026-01-03T00:00:00Z'}
 ]);
 assert.deepEqual(ranked.map(item=>item.title),['Fast finish','Long repair']);
});
test('shared-cause unblockers outrank otherwise equal isolated repairs',()=>{
 const common='Provider authentication failed on worker';
 const ranked=rankPartnerItems([
  {projectId:a,runId:ra,title:'Isolated',status:'blocked',blocker:'One-off test failure',proposedFix:'Repair',approvalCount:0,remainingStages:2},
  {projectId:b,runId:rb,title:'Shared one',status:'blocked',blocker:common,proposedFix:'Repair',approvalCount:0,remainingStages:2},
  {projectId:b,runId:approvalId,title:'Shared two',status:'blocked',blocker:common,proposedFix:'Repair',approvalCount:0,remainingStages:2}
 ]);
 assert.equal(ranked[0].blocker,common);assert.equal(ranked[1].blocker,common);
});
test('warning queue growth raises matching Partner work without granting authority',()=>{
 const ranked=rankPartnerItems([
  {projectId:a,runId:ra,title:'Stable blocked',status:'blocked',blocker:'A',proposedFix:'Repair',approvalCount:0,remainingStages:2,queueTrendDelta:0,queueTrendTone:'neutral'},
  {projectId:b,runId:rb,title:'Growing failures',status:'failed',blocker:'B',proposedFix:'Repair',approvalCount:0,remainingStages:2,queueTrendDelta:3,queueTrendTone:'warning',queueTrendAction:'Prioritize demonstrated failure causes.'}
 ]);
 assert.equal(ranked[0].title,'Growing failures');
 assert.equal(ranked[0].queueTrendAction,'Prioritize demonstrated failure causes.');
});
test('queue-wide approval still binds exact conversation, run, project and disclosed payload',async()=>{
 const f=fixture();f.items[1].approvalCount=1;f.approvals.push({id:approvalId,projectId:b,runId:rb,status:'pending',actionType:'local_command',target:'npm run check',payload:{command:'npm run check'}});
 const preview=await processPartnerMessage(message('fix it',{runId:rb}),f.adapter);assert.equal(preview.proposal?.projectId,b);assert.deepEqual(f.effects,[]);
 assert.equal((await processPartnerMessage(message('approved',{runId:ra,proposalId:preview.proposal!.id,idempotencyKey:'bad-selection'}),f.adapter)).status,'blocked');assert.deepEqual(f.effects,[]);
 await processPartnerMessage(message('approved',{runId:rb,proposalId:preview.proposal!.id,idempotencyKey:'approve-beta'}),f.adapter);assert.deepEqual(f.effects,[`approval:${b}:${approvalId}`]);assert.deepEqual(f.claims,[b]);
});
test('forged project ownership never borrows a project adapter, claim or approval',async()=>{
 const f=fixture();await assert.rejects(()=>f.adapter.repair({...f.items[1],projectId:a},'fix it'),/owner/);assert.deepEqual(f.claims,[]);assert.deepEqual(f.effects,[]);
 const approval:PartnerApproval={id:approvalId,projectId:a,runId:rb,status:'pending',actionType:'local_command',target:'check',payload:{}};
 await assert.rejects(()=>f.adapter.approve(approval),/owner/);
 f.owners.set(`run:${rb}`,'unavailable-project');assert.equal(await f.adapter.item(rb),null);assert.equal(await f.adapter.canAct?.('unavailable-project'),false);
});
test('ownership and role changes between reservation and effect are rechecked',async()=>{
 const f=fixture();await assert.rejects(()=>f.adapter.once('key','hash',rb,async()=>{f.denied.add(b);await f.adapter.repair(f.items[1],'fix it');throw Error('unreachable');}),/role/);assert.deepEqual(f.effects,[]);
});
test('identical project-free retransmission after a queue change cannot select another owner',async()=>{
 const f=fixture(),input=message('pick up the next blocked item');
 const first=await processPartnerMessage(input,f.adapter);assert.equal(first.selectedRunId,rb);f.items[1].status='running';
 const replay=await processPartnerMessage(input,f.adapter);assert.equal(replay.replayed,true);assert.equal(replay.selectedRunId,rb);assert.deepEqual(f.effects,[`repair:${b}:${rb}`]);assert.deepEqual(f.claims,[b]);
 const changed=await processPartnerMessage({...input,runId:rb},f.adapter);assert.equal(changed.status,'review');assert.equal(f.effects.length,1);
 // A new adapter/process uses the same durable ledger rather than reselecting.
 const restarted=fixture(f.requests);restarted.items.splice(1,1);const again=await processPartnerMessage(input,restarted.adapter);assert.equal(again.replayed,true);assert.equal(again.selectedRunId,rb);assert.deepEqual(restarted.effects,[]);
});
test('concurrent project-free delivery claims once before either selection or project effects',async()=>{
 const f=fixture(),input=message('pick up the next blocked item');const results=await Promise.all([processPartnerMessage(input,f.adapter),processPartnerMessage(input,f.adapter)]);
 assert.equal(f.effects.length,1);assert.equal(f.claims.length,1);assert.ok(results.some(r=>r.status==='review'||r.replayed));
});
test('uncertain queue-wide claims never clear, expire into selection or execute a different project',async()=>{
 const requests=ledgerFixture(),once=createQueuePartnerRequestLedger(a,requests.store),input=message('pick up the next blocked item');let calls=0;
 assert.equal((await once(input,async()=>{calls++;throw Error('Effect outcome unavailable');})).status,'review');
 for(const row of requests.rows.values())row.status='uncertain';
 const differentHost=createQueuePartnerRequestLedger(b,requests.store);
 assert.equal((await differentHost(input,async()=>{calls++;throw Error('must not run');})).status,'review');assert.equal(calls,1);
});
test('request ledger failure or lost settlement fence preserves the breaker before any reselection',async()=>{
 const requests=ledgerFixture(),input=message('pick up the next blocked item');let calls=0;
 const unavailable=createQueuePartnerRequestLedger(a,{...requests.store,claim:async()=>{throw Error('Storage unavailable');}});
 assert.equal((await unavailable(input,async()=>{calls++;throw Error('must not select');})).status,'review');assert.equal(calls,0);
 const lost=createQueuePartnerRequestLedger(a,{...requests.store,finalize:async()=>false});
 const reply={kind:'queue_partner_chat_report' as const,status:'queued' as const,text:'First selected owner only',items:[],selectedRunId:ra};
 assert.equal((await lost(input,async()=>{calls++;return reply;})).status,'review');
 assert.equal((await lost(input,async()=>{calls++;return reply;})).status,'review');assert.equal(calls,1);
});
