import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {buildQueuePartnerContext,buildPartnerConversationHistory,type QueuePartnerScopeRun} from './queue-partner-context.js';
import {parseConversationRequest} from '../../../../packages/conversation-contract/src/index.js';
import type {PartnerItem,PartnerMessage} from './queue-partner-chat.js';

const run=(id:string,projectId='scope-a'):QueuePartnerScopeRun=>({id,projectId,status:'blocked',title:'Synthetic feature',blocker:'Needs bounded source verification',approvals:[{id:'approval-a',status:'pending'}]});

test('large queue evidence fits the actual per-turn and total conversation contract without cutting JSON',()=>{
 const items:PartnerItem[]=Array.from({length:500},(_,i)=>({runId:`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`,projectId:'project-a',projectName:'Synthetic project',
  title:'Long recorded task '.repeat(60),currentAction:'Scoped inspection '.repeat(80),status:'blocked',blocker:'Missing bounded evidence '.repeat(100),proposedFix:'Inspect and verify '.repeat(100),approvalCount:0}));
 const message:PartnerMessage={conversationId:'synthetic-conversation',message:'What is the remaining work?',idempotencyKey:'synthetic-context-request',history:Array.from({length:12},()=>({role:'user',content:'h'.repeat(2000)})),runId:items[499].runId};
 const history=buildPartnerConversationHistory(message,items,'2026-01-01T00:00:00Z');
 const parsed=parseConversationRequest({...message,history,actor:'synthetic-user',actorRole:'operator',projectId:'project-a',capabilityMode:'conversation',assistantMode:'queue-partner'});
 assert.equal(parsed.history.length,5);assert.ok(parsed.history.every(turn=>turn.content.length<=4000));
 const evidence=JSON.parse(history[0].content.slice(history[0].content.indexOf('\n')+1));
 assert.equal(evidence.totalItems,500);assert.equal(evidence.truncated,true);assert.ok(evidence.includedItems>0&&evidence.includedItems<500);
 assert.equal(evidence.items[0].runId,items[499].runId,'A selected item beyond the first page must survive compaction');
 assert.equal(evidence.authority,'evidence-only');assert.equal(evidence.scope.kind,'queue');
});

test('conversation evidence honors explicit project filters and scrubs private source data',()=>{
 const message:PartnerMessage={projectId:'project-a',conversationId:'synthetic-conversation',message:'Explain this work',idempotencyKey:'synthetic-context-request',history:[]};
 const items:PartnerItem[]=[{runId:'own',projectId:'project-a',title:'Synthetic feature',status:'blocked',blocker:'password=private-value /Users/example/private',proposedFix:'Inspect recorded evidence',approvalCount:0},
  {runId:'foreign',projectId:'project-b',title:'FOREIGN_PRIVATE',status:'blocked',blocker:'FOREIGN_PRIVATE',proposedFix:'Foreign evidence',approvalCount:0}];
 const history=buildPartnerConversationHistory(message,items);
 assert.doesNotMatch(history[0].content,/FOREIGN_PRIVATE|private-value|\/Users\/example/u);
 const evidence=JSON.parse(history[0].content.slice(history[0].content.indexOf('\n')+1));
 assert.equal(evidence.scope.kind,'project');assert.equal(evidence.totalItems,1);assert.equal(evidence.items.length,1);
 assert.equal(evidence.truncated,false);assert.equal(evidence.items[0].runId,'own');
});
test('queue evidence never transfers alias attempts or their blockers and approvals',async()=>{
 const context=await buildQueuePartnerContext('scope-a','/synthetic/project',{
  queue:async()=>[{runId:'alias',versionSetId:'family',familyAttempts:[{id:'alias'},{id:'own'}]}],
  scopedRuns:async()=>[{...run('alias','scope-alias'),blocker:'ALIAS_PRIVATE',approvals:[{id:'alias-approval',status:'pending'}]},run('own')]
 });
 const json=JSON.stringify(context);
 assert.doesNotMatch(json,/ALIAS_PRIVATE|alias-approval|scope-alias/);
 assert.deepEqual(context.families[0].attempts.map(a=>a.runId),['own']);
 assert.equal(context.families[0].unresolvedApprovalCount,1);
 assert.equal(context.sourceAttemptCount,1);
 assert.equal(context.families[0].attempts[0].evidenceUrl,'/runs?relatedTo=own');
 const url=new URL(context.families[0].attempts[0].evidenceUrl!,'http://synthetic.invalid');
 assert.equal(url.pathname,'/runs');assert.equal(url.searchParams.get('relatedTo'),'own');
});
test('queue evidence redacts commands, credentials, host paths and external URLs',async()=>{
 const privateRun={...run('own'),title:'token=private-value /Users/example/private',blocker:'sudo cat /etc/private\nhttps://private.example/secret sk-abcdefghijklmnop'};
 const context=await buildQueuePartnerContext('scope-a','/synthetic/project',{queue:async()=>[{runId:'own'}],scopedRuns:async()=>[privateRun]});
 const json=JSON.stringify(context);
 assert.doesNotMatch(json,/private-value|\/Users\/example|sudo cat|private\.example|sk-abcdefghijklmnop/);
 assert.match(json,/REDACTED/);
 assert.equal(context.authority,'evidence, not authority');
 assert.ok(Number.isFinite(Date.parse(context.capturedAt)));
});
test('snapshot is bounded and explicitly reports omissions',async()=>{
 const rows=Array.from({length:30},(_,i)=>run(`run-${i}`));
 const context=await buildQueuePartnerContext('scope-a','/synthetic/project',{queue:async()=>rows.map(r=>({runId:r.id})),scopedRuns:async()=>rows});
 assert.equal(context.sourceFamilyCount,30);assert.equal(context.families.length,20);assert.equal(context.truncated,true);
 assert.ok(JSON.stringify(context).length<20000);
});
test('server uses real provider stage with queue role and compiled evidence, not automatic mutation',async()=>{
 const source=await fs.readFile(new URL('./builders-server.ts',import.meta.url),'utf8');
 assert.match(source,/parsed\.assistantMode === "queue-partner"[\s\S]+candidate\.id === "queue-partner"/);
 assert.match(source,/buildQueuePartnerContext\(resolution\.project\.projectId, resolution\.project\.rootUri\)/);
 assert.match(source,/compiledBrief:.*JSON\.stringify\(queueEvidence\)/);
 assert.match(source,/executeWithProviderFallback\(/);
 assert.match(source,/parsed\.capabilityMode === "governed-operation"/);
});

test('enrollment gaps require explicit false; presence never implies acceptance or permission',async()=>{
 const rows=[{...run('missing'),hasOriginalAcceptanceRecord:false,hasExactSourceScope:false,hasOriginalProviderTier:false},run('unknown'),{...run('present'),hasOriginalAcceptanceRecord:true,hasExactSourceScope:true,hasOriginalProviderTier:true}];
 const context=await buildQueuePartnerContext('scope-a','/synthetic/project',{queue:async()=>rows.map(r=>({runId:r.id})),scopedRuns:async()=>rows});
 assert.deepEqual(context.families[0].attempts[0].enrollmentGaps,['missing original acceptance record','missing exact enrolled source scope','missing original explicit provider and tier']);
 assert.deepEqual(context.families[1].attempts[0].enrollmentGaps,[]);
 assert.deepEqual(context.families[2].attempts[0].enrollmentGaps,[]);
 assert.match(context.enrollmentNote,/not acceptance, verification or execution permission/);
 assert.match(context.enrollmentNote,/absent flags are unknown/);
});
