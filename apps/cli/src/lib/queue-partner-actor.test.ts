import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {buildPartnerRecoveryTask,compactPartnerComparisonEvidence,compactPartnerPriorFacts,partnerCanInvestigate,partnerActorFingerprint,partnerRecoveryCommands,runPartnerActor,runPartnerActors,driveOwnedPartnerChild,readOwnedPartnerChildOnClient,selectPartnerWorkerAgent,verifiedPartnerRecoveryFacts,partnerRecoveryEvidenceDigest,type PartnerActorAdapter,type PartnerActorSource,type PartnerChildState} from './queue-partner-actor.js';
import type {QueuePartnerComparison} from './queue-partner-memory.js';
import {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {chainReceipt} from '../../../../packages/workflow-engine/src/receipt-chain.js';
import {withClient} from '../../../../packages/storage/src/client.js';
import type {QueueCoordinatorFamily} from '../../../../packages/workflow-engine/src/queue-coordinator-plan.js';
const family=(id='original'):QueueCoordinatorFamily=>({familyId:id,sourceRunId:id,projectId:'project',projectRootUri:'/synthetic',canonical:true,activeRunIds:[],pendingApprovalIds:[],fileScopes:[],failureFingerprint:'a'.repeat(64),priorFingerprint:null,repairDepth:0,verificationReady:false,originalAcceptancePresent:false,sourceEvidenceReady:false,blocker:'Missing original source evidence'});
const source=(id='original'):PartnerActorSource=>({id,status:'blocked',activeQueueMember:true,task:'Repair the intended feature',root_uri:'/synthetic',profile:'local',registration_profile:'enterprise',metadata:{},provider_override:null,model_tier_override:null,blocker:'Missing evidence'});
function harness(){
 const events:string[]=[];
 const adapter:PartnerActorAdapter={
  prepare:async f=>({binding:{projectId:f.projectId,projectRootUri:f.projectRootUri,sourceRunId:f.sourceRunId,familyId:f.familyId,fileScopes:[`runtime/queue-partner/recovery/${f.sourceRunId}`],fingerprint:'a'.repeat(64),taskHash:'b'.repeat(64),policyHash:'c'.repeat(64),sourceHash:null,writePaths:[]},execute:async()=>{events.push('model-and-governed-actions');return {state:'held',reason:'Actual evidence returned',runId:'child'};}}),
  acquire:async()=>{events.push('intent');return {fencingToken:'7'};},
  reserve:async input=>{events.push('claim');return {...input,id:'claim',fence:'11',role:'repair',lane:1};},
  finish:async(_c,state)=>{events.push(`finish:${state}`);},release:async()=>{events.push('release');},observe:async()=>{events.push('journal');}
 };
 return {adapter,events};
}
test('missing old enrollment gets autonomous investigation, not technical chat escalation',()=>{
 assert.equal(partnerCanInvestigate(family(),source(),'missing source evidence or original acceptance'),true);
 for(const f of [{...family(),activeRunIds:['live']},{...family(),pendingApprovalIds:['approval']},{...family(),canonical:false},{...family(),reconciliationHoldReason:'uncertain'}])assert.equal(partnerCanInvestigate(f,source(),'missing evidence'),false);
 for(const metadata of [{suiteId:'separate'},{evaluationId:'paid'},{source:'training-evaluation'},{sourceRunId:'derived'}])assert.equal(partnerCanInvestigate(family(),{...source(),metadata},'missing evidence'),false);
 for(const reason of ['item capacity','overlapping execution scope','family already active'])assert.equal(partnerCanInvestigate(family(),source(),reason),false);
});
test('an enrolled exact source uses the existing candidate and verifier pipeline instead of another discovery actor',()=>{
 const f={...family(),originalAcceptancePresent:true,sourceEvidenceReady:true};
 for(const reason of ['external proof or authority required','unchanged failure suppressed','verifier backpressure'])assert.equal(partnerCanInvestigate(f,source(),reason),false);
});
test('source lifecycle preflight matches the reservation boundary without reviving cancelled work',()=>{
 for(const status of ['failed','blocked','completed'])assert.equal(partnerCanInvestigate(family(),{...source(),status},'missing evidence'),true,status);
 for(const status of ['cancelled','queued','leased','running','unknown','',undefined,null]){
  assert.equal(partnerCanInvestigate(family(),{...source(),status:status as string},'missing evidence'),false,String(status));
 }
});
test('an ineligible source performs no preparation, intent acquisition, reservation or model work',async()=>{
 for(const status of ['cancelled','queued','leased','running','unknown','',undefined,null]){
  const {adapter,events}=harness(),prepare=adapter.prepare;
  adapter.prepare=async(f,s)=>{events.push('prepare');return prepare(f,s);};
  const result=await runPartnerActor(family(),{...source(),status:status as string},adapter,{onSettled:()=>events.push('wake')});
  assert.equal(result.state,'suppressed',String(status));assert.deepEqual(events,[],String(status));
 }
});
test('an inactive or missing source membership stops before preparation even for a terminal lifecycle',async()=>{
 for(const activeQueueMember of [false,undefined,null]){
  const h=harness();h.adapter.prepare=async()=>{assert.fail('Historical source must not prepare');};
  const s={...source(),activeQueueMember:activeQueueMember as boolean};
  assert.equal(partnerCanInvestigate(family(),s,'missing evidence'),false);
  assert.equal((await runPartnerActor(family(),s,h.adapter)).state,'suppressed');assert.deepEqual(h.events,[]);
 }
});
test('an actor invokes its model/action driver only after the scoped intent and real claim, then finalizes and refills',async()=>{
 const {adapter,events}=harness();
 const result=await runPartnerActor(family(),source(),adapter,{onSettled:()=>{events.push('wake');}});
 assert.equal(result.state,'held');assert.equal('runId' in result?result.runId:undefined,'child');
 assert.ok('phaseTimings' in result&&result.phaseTimings&&Object.values(result.phaseTimings).every(value=>Number.isFinite(value)&&value>=0));
 assert.deepEqual(events,['intent','claim','model-and-governed-actions','finish:held','release','journal','wake']);
});
test('reservation refusal releases the intent without model work, outcome mutation or refill wake',async()=>{
 const {adapter,events}=harness();adapter.reserve=async()=>null;
 assert.equal((await runPartnerActor(family(),source(),adapter,{onSettled:()=>{events.push('wake');}})).state,'suppressed');
 assert.deepEqual(events,['intent','release']);
});
test('missing verification or source ownership creates its exact decision before consuming a repair attempt',async()=>{
 const {adapter,events}=harness(),prepare=adapter.prepare;
 adapter.prepare=async(f,s)=>({...await prepare(f,s),admission:async()=>{events.push('preflight-decision');return {ready:false,reason:'Exact recipe and baseline need approval',approvalId:'exact-approval'};}});
 const result=await runPartnerActor(family(),source(),adapter);
 assert.equal(result.state,'approval-required');assert.equal('approvalId'in result?result.approvalId:undefined,'exact-approval');
 assert.deepEqual(events,['intent','preflight-decision','release']);
});
test('ready admission proceeds through the existing fenced repair driver',async()=>{
 const {adapter,events}=harness(),prepare=adapter.prepare;
 adapter.prepare=async(f,s)=>({...await prepare(f,s),admission:async()=>{events.push('preflight-ready');return {ready:true,reason:'Exact source and recipe available'};}});
 await runPartnerActor(family(),source(),adapter);
 assert.deepEqual(events,['intent','preflight-ready','claim','model-and-governed-actions','finish:held','release','journal']);
});
test('a stop during intent acquisition releases only that unclaimed intent',async()=>{
 const {adapter,events}=harness();let stop=false;
 adapter.acquire=async()=>{stop=true;events.push('intent');return {fencingToken:'7'};};
 assert.equal((await runPartnerActor(family(),source(),adapter,{shouldStop:()=>stop})).state,'draining');
 assert.deepEqual(events,['intent','release']);
});
test('stop after a reservation drains owned work; uncertainty retains source ownership and no automatic retry',async()=>{
 const {adapter,events}=harness();let stop=false;
 const reserve=adapter.reserve;adapter.reserve=async input=>{const c=await reserve(input);stop=true;return c;};
 assert.equal((await runPartnerActor(family(),source(),adapter,{shouldStop:()=>stop})).state,'held');
 assert.ok(events.includes('model-and-governed-actions'));
 const failed=harness();failed.adapter.prepare=async()=>{const p=await adapter.prepare(family(),source());return {...p,execute:async()=>{throw Error('Provider disconnected after effects');}};};
 assert.equal((await runPartnerActor(family(),source(),failed.adapter)).state,'uncertain');
 assert.ok(failed.events.includes('finish:uncertain'));assert.ok(!failed.events.includes('release'));
});
test('journal or cleanup failure does not relabel an already finalized model result',async()=>{
 const h=harness();h.adapter.observe=async()=>{throw Error('Journal unavailable');};
 assert.equal((await runPartnerActor(family(),source(),h.adapter)).state,'held');
 const cleanup=harness();cleanup.adapter.release=async()=>{throw Error('Cleanup unavailable');};
 assert.equal((await runPartnerActor(family(),source(),cleanup.adapter)).state,'held');
 assert.deepEqual(cleanup.events.filter(e=>e.startsWith('finish:')),['finish:held']);
});
test('bounded pool skips old refused rows so eligible items after the first five still get real model work',async()=>{
 const h=harness(),reserved=h.adapter.reserve,called:string[]=[];
 h.adapter.reserve=async input=>Number(input.sourceRunId)<5?null:reserved(input);
 h.adapter.prepare=async f=>{const p=await harness().adapter.prepare(f,source(f.sourceRunId));return {...p,execute:async()=>{called.push(f.sourceRunId);return {state:'held',reason:'Executed'};}};};
 const families=Array.from({length:8},(_,i)=>family(String(i))),sources=new Map(families.map(f=>[f.sourceRunId,source(f.sourceRunId)]));
 const results=await runPartnerActors(families,sources,h.adapter);
 assert.deepEqual(called.sort(),['5','6','7']);assert.equal(results.length,8);
});
test('a measured recovery pass stays inside five and yields refill to fresh priority planning',async t=>{
 const h=harness(),families=Array.from({length:5},(_,i)=>family(`parallel-${i}`)),sources=new Map(families.map(f=>[f.sourceRunId,source(f.sourceRunId)]));
 const gates=new Map<string,()=>void>();let active=0,peak=0,stop=false;
 h.adapter.prepare=async f=>{const p=await harness().adapter.prepare(f,source(f.sourceRunId));return {...p,execute:async()=>{
  active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>gates.set(f.familyId,resolve));active--;return {state:'held',reason:'Finished real driver'};
 }};};
 const running=runPartnerActors(families,sources,h.adapter,{shouldStop:()=>stop,maxActors:5});
 t.after(async()=>{stop=true;for(const release of gates.values())release();await running;});
 await setImmediate();assert.equal(active,5);gates.values().next().value!();await setImmediate();assert.equal(active,4);assert.equal(gates.size,5,'A stale recovery pool must not jump ahead of a newly ready verifier');assert.equal(peak,5);
 for(const release of gates.values())release();await setImmediate();for(const release of gates.values())release();await running;assert.equal(active,0);assert.equal(peak,5);
 await assert.rejects(runPartnerActors([],sources,h.adapter,{maxActors:6}));
});
test('semantic fingerprint is stable for path order and changes only with relevant inputs',()=>{
 const input={task:'Original goal',blocker:'Test fails',reason:'Technical gap',policyHash:'p',sourceHash:'s',writePaths:['b.ts','a.ts'],provider:null,tier:null};
 const first=partnerActorFingerprint(input);assert.equal(first,partnerActorFingerprint({...input,writePaths:['a.ts','b.ts']}));
 assert.notEqual(first,partnerActorFingerprint({...input,sourceHash:'changed'}));assert.notEqual(first,partnerActorFingerprint({...input,policyHash:'changed'}));
});
test('actor recipes exclude broad scripts and foreign tests even when the project grants broad commands',()=>{
 const project=projectConfigSchema.parse({project:{name:'Synthetic recipes'},actions:{allowed_commands:['npm *','node *','python3 *','git diff --check'],blocked_commands:[]}});
 const commands=partnerRecoveryCommands(project,['src/a.ts','tests/a.test.ts','tests/test_a.py']);
 assert.ok(commands.includes('node --import tsx --test tests/a.test.ts'));assert.ok(commands.includes('python3 -m py_compile tests/test_a.py'));
 assert.ok(commands.includes('python3 -m unittest discover -s tests -p test_a.py -v'));
 assert.ok(!commands.some(c=>c.startsWith('npm ')));assert.ok(!commands.some(c=>c.includes('foreign')));
 const code=readFileSync(new URL('./queue-partner-actor.ts',import.meta.url),'utf8');assert.match(code,/isolate_command_writes:true/);
});
test('focused Python recipes still require the current grant and do not expand exact grants or blocked patterns',()=>{
 const exact=projectConfigSchema.parse({project:{name:'Exact recipes'},actions:{allowed_commands:['python3 -m unittest discover -s tests','git diff --check'],blocked_commands:[]}});
 assert.deepEqual(partnerRecoveryCommands(exact,['tests/test_a.py']),['git diff --check']);
 const blocked=projectConfigSchema.parse({project:{name:'Blocked tests'},actions:{allowed_commands:['python3 *'],blocked_commands:['python3 -m unittest *']}});
 assert.ok(!partnerRecoveryCommands(blocked,['tests/test_a.py']).some(c=>c.includes('unittest')));
 assert.ok(!partnerRecoveryCommands(blocked,['tests/../test_foreign.py','tests/test_a.py;bad']).some(c=>c.includes('unittest')));
});
test('repair recipes retain a declared exact environment capability without inheriting broad shell grants',()=>{
 const capability='npm run agentflow -- environments *';
 const environments={profiles:{focused:{kind:'native',platform:'darwin/arm64',source_paths:['src/a.ts'],readiness:[{argv:['node','--version']}]}}};
 const make=(allowed_commands:string[],blocked_commands:string[]=[],declared=true)=>projectConfigSchema.parse({project:{name:'Bounded repair environment'},
  execution:declared?{environments}:{},actions:{allowed_commands,blocked_commands}});
 assert.ok(partnerRecoveryCommands(make([capability]),['src/a.ts']).includes(capability));
 assert.ok(!partnerRecoveryCommands(make(['npm *']),['src/a.ts']).includes(capability));
 assert.ok(!partnerRecoveryCommands(make([capability],[],false),['src/a.ts']).includes(capability));
 assert.ok(!partnerRecoveryCommands(make([capability],['npm *']),['src/a.ts']).includes(capability));
 assert.ok(!partnerRecoveryCommands(make([capability,'npm *','git *']),['src/a.ts']).includes('git *'));
});
test('owned queued continuation waits on the same child instead of declaring the availability fence uncertain',async()=>{
 let clock=0,calls=0,waits=0;
 const result=await driveOwnedPartnerChild('same-child',{
  claim:async()=>({claimed:++calls>3?1:0}),
  read:async()=>({status:calls>3?'completed':'running',owned:true,queued:true,busy:false,availableAt:3000}),
  wait:async ms=>{clock+=ms;waits++;},now:()=>clock,shouldStop:()=>false
 });
 assert.equal(result.state,'held');assert.equal(result.runId,'same-child');assert.equal(waits,3);assert.equal(calls,4);
});
test('continuation keeps ownership fenced on lost intent, foreign lease, unknown state or a bounded wait exhaustion',async()=>{
 const base:PartnerChildState={status:'running',owned:true,queued:true,busy:false,availableAt:0};
 for(const patch of [{owned:false},{busy:true},{queued:false},{availableAt:null},{availableAt:NaN},{availableAt:31000},{}]){
  let clock=0,calls=0;
  const result=await driveOwnedPartnerChild('same-child',{claim:async()=>{calls++;return {claimed:0};},read:async()=>({...base,...patch}),wait:async ms=>{clock+=ms;},now:()=>clock,shouldStop:()=>false});
  assert.equal(result.state,'uncertain');assert.ok(calls<=31);assert.ok(clock<=30000);
 }
});
test('continuation retains the eight-claim breaker and stops on intent loss without another worker call',async()=>{
 let calls=0;
 const driver={claim:async()=>{calls++;return {claimed:1};},read:async()=>({status:'running',owned:true,queued:true,busy:false,availableAt:0}),wait:async()=>{},now:()=>0,shouldStop:()=>false};
 assert.equal((await driveOwnedPartnerChild('same-child',driver)).state,'uncertain');assert.equal(calls,8);
 await assert.rejects(()=>driveOwnedPartnerChild('same-child',{...driver,shouldStop:()=>true}),/intent fence lost/);assert.equal(calls,8);
});
test('every terminal observation still requires the exact live ownership fence',async()=>{
 for(const status of ['completed','blocked','failed','cancelled'])for(const owned of [false,true]){
  const result=await driveOwnedPartnerChild('same-child',{claim:async()=>({claimed:0}),read:async()=>({status,owned,queued:false,busy:false,availableAt:null}),wait:async()=>{assert.fail('Terminal observations never poll');},now:()=>0,shouldStop:()=>false});
  assert.equal(result.state,owned?'held':'uncertain',`${status} owned=${owned}`);
 }
});
test('empty-poll database latency consumes the wait budget; slow reads do not rearm another delay',async()=>{
 let clock=0,calls=0;
 const result=await driveOwnedPartnerChild('same-child',{claim:async()=>{calls++;clock+=31000;return {claimed:0};},read:async()=>({status:'running',owned:true,queued:true,busy:false,availableAt:0}),wait:async()=>{assert.fail('Elapsed idle budget already exhausted');},now:()=>clock,shouldStop:()=>false});
 assert.equal(result.state,'uncertain');assert.equal(calls,1);
});
test('production ownership SQL supports text intent project ids and UUID claims, preserving every live fence',async()=>withClient(async c=>{
 await c.query('begin');
 try{
  await c.query(`create temp table workflow_runs(id uuid primary key,project_id uuid,status text) on commit drop;
   create temp table work_intents(project_id text,owner text,fencing_token bigint,expires_at timestamptz) on commit drop;
   create temp table queue_coordinator_assignments(id text primary key,project_id uuid,child_run_id uuid,owner text,fence bigint,intent_fence text,state text) on commit drop;
   create temp table workflow_tasks(run_id uuid,status text,available_at timestamptz) on commit drop;`);
  const runId=randomUUID(),projectId=randomUUID(),claim={id:randomUUID(),owner:'synthetic-owner',fence:'7',intentFence:'3'};
  await c.query("insert into workflow_runs values($1,$2,'running')",[runId,projectId]);
  await c.query("insert into work_intents values($1,$2,3,clock_timestamp()+interval '10 minutes')",[projectId,claim.owner]);
  await c.query("insert into queue_coordinator_assignments values($1,$2,$3,$4,7,'3','running')",[claim.id,projectId,runId,claim.owner]);
  await c.query("insert into workflow_tasks values($1,'queued',clock_timestamp()+interval '2 seconds')",[runId]);
  const current=await readOwnedPartnerChildOnClient(c,runId,claim);
  assert.equal(current.owned,true);assert.equal(current.queued,true);assert.equal(current.busy,false);assert.ok(Number.isFinite(current.availableAt));
  for(const changed of [{...claim,owner:'foreign'},{...claim,fence:'8'},{...claim,intentFence:'4'}])assert.equal((await readOwnedPartnerChildOnClient(c,runId,changed)).owned,false);
  await c.query("update workflow_runs set status='completed'");
  assert.equal((await readOwnedPartnerChildOnClient(c,runId,claim)).owned,true,'Terminal lifecycle alone does not release the live fence');
  await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second'");
  assert.equal((await readOwnedPartnerChildOnClient(c,runId,claim)).owned,false);
  await c.query("update work_intents set expires_at=clock_timestamp()+interval '10 minutes'");
  await c.query("update queue_coordinator_assignments set state='uncertain'");
  assert.equal((await readOwnedPartnerChildOnClient(c,runId,claim)).owned,false);
  const foreignProject=randomUUID();
  await c.query("update queue_coordinator_assignments set state='running',project_id=$1",[foreignProject]);
  await c.query("insert into work_intents values($1,$2,3,clock_timestamp()+interval '10 minutes')",[foreignProject,claim.owner]);
  assert.equal((await readOwnedPartnerChildOnClient(c,runId,claim)).owned,false,'A valid foreign-project intent cannot own this child');
 }finally{await c.query('rollback');}
}));
test('prior failure facts require an intact same-run chain; failed checks are not silently lost or relabeled',()=>{
 const first=chainReceipt('GENESIS',{runId:'prior',agentId:'queue-partner',actionType:'local_command',target:'git diff --check',summary:'New blank line at EOF',metadata:JSON.stringify({exitCode:2,timedOut:false}),metadataSerializationVersion:2,createdAt:'2026-01-01T00:00:00.000Z'});
 const facts=verifiedPartnerRecoveryFacts('prior',[first]);assert.equal(facts[0]?.exitCode,2);assert.match(facts[0]?.summary??'',/EOF/);
 assert.deepEqual(verifiedPartnerRecoveryFacts('foreign',[first]),[]);assert.deepEqual(verifiedPartnerRecoveryFacts('prior',[{...first,summary:'passed'}]),[]);
 assert.deepEqual(verifiedPartnerRecoveryFacts('prior',[{...first,prevHash:'missing'}]),[]);
 assert.equal(partnerRecoveryEvidenceDigest(facts),partnerRecoveryEvidenceDigest(facts.map(f=>({...f,runId:'different generated id',summary:'different model prose'}))));
 assert.notEqual(partnerRecoveryEvidenceDigest(facts),partnerRecoveryEvidenceDigest(facts.map(f=>({...f,exitCode:0}))));
});
test('Partner prompt comparisons retain lookup and decision evidence without repeating full historical tasks or path arrays',()=>{
 const verbose='PRIVATE HISTORICAL TASK '.repeat(300),comparison={projectId:'project',familyId:'project:family',sourceRunId:'source',childRunId:'child',task:verbose,
  blocker:'PRIVATE HISTORICAL BLOCKER '.repeat(100),writePaths:Array.from({length:30},(_,index)=>`src/private-${index}.ts`),outcome:'blocked',recordedAt:'2026-01-01T00:00:00.000Z',
  facts:[],score:42,evidenceDigest:'a'.repeat(64),authority:'evidence-only',recurrence:true,regression:false,relationship:'overlapping-paths',interpretation:'related-prior-failure',
  rankingSignals:{relevance:50,reliability:-8,verification:0,speed:0,cost:0}} satisfies QueuePartnerComparison;
 const report=compactPartnerComparisonEvidence([comparison,comparison],{eligible:[],rejected:[{sourceRunId:'source',repairRunId:'child',evidenceDigest:'a'.repeat(64),reason:'missing-applicability-proof'}]},['src/private-2.ts']);
 const encoded=JSON.stringify(report);
 assert.equal(report.total,2);assert.equal(report.cohorts.length,1);assert.equal(report.cohorts[0]?.attempts.length,2);assert.equal(report.cohorts[0]?.attempts[0]?.childRunId,'child');
 assert.deepEqual(report.cohorts[0]?.matchingPaths,['src/private-2.ts']);assert.equal(report.cohorts[0]?.priorPathCount,30);
 assert.equal(report.cohorts[0]?.attempts[0]?.rejectionReason,'missing-applicability-proof');assert.match(report.fullRecordLookup,/childRunId plus evidenceDigest/);
 assert.doesNotMatch(encoded,/PRIVATE HISTORICAL TASK|PRIVATE HISTORICAL BLOCKER|private-29/);assert.ok(encoded.length<3000,encoded.length.toString());
});
test('Partner recovery brief references injected policy by digest and remains bounded without dropping authority or acceptance guards',()=>{
 const comparisonEvidence=compactPartnerComparisonEvidence([], {eligible:[],rejected:[]}, ['src/main.ts']);
 const facts=[{runId:'prior',kind:'local_command',target:'npm test',summary:'x'.repeat(1000),exitCode:1}];
 assert.equal(compactPartnerPriorFacts(facts)[0]?.summary.length,240);
 const task=buildPartnerRecoveryTask({strategy:'repair-exact-source',workerAgentId:'implementation-agent',writePaths:['src/main.ts'],priorFacts:facts,comparisonEvidence,repairPlaybooks:{eligible:[],rejected:[]},
  source:{...source(),task:'Deliver the bounded repair',blocker:'A focused test fails'},familyId:'project:family',owner:'partner',intentFence:'7',reason:'Current acceptance gap',
  policyHash:'a'.repeat(64),sourceHash:'b'.repeat(64),allowedCommands:['npm test','npm run typecheck']});
 assert.match(task,/separately injected Project action policy is the exact command\/write grant/);assert.match(task,/Completion of this turn is not original-product acceptance/);
 assert.match(task,/"writePathCount":1/);assert.match(task,/"allowedCommandCount":2/);assert.match(task,/"taskDigest":"[a-f0-9]{64}"/);
 assert.doesNotMatch(task,/Exact permitted write paths|Current literal command policy|npm run typecheck/);assert.ok(task.length<5000,task.length.toString());
 assert.match(task,/one named original outcome only/);
 assert.match(task,/Never create an all-encompassing project\/queue repair wrapper or repair-of-repair wrapper/);
 assert.match(task,/current failure evidence, exact source\/test scope and a verifiable acceptance gate/);
 assert.match(task,/exact owning project and dependency/);
 assert.match(task,/never edit a vendor mirror, copy grants/);
 const partner=readFileSync(new URL('../../../../agents/operations/queue-partner.yaml',import.meta.url),'utf8');
 assert.match(partner,/Trace existing wrappers/);
 assert.match(partner,/Missing control-plane evidence is coordinator work to supply/);
 assert.match(partner,/treat that as blocker amplification/);
 assert.match(partner,/pause new sibling recovery dispatch/);
 assert.match(partner,/preserve genuine live lease owners/);
 assert.match(partner,/repair the shared mechanism/);
 assert.match(partner,/never clear cards/);
});
test('Queue Partner delegates bounded technical turns to the smallest existing specialist team member',()=>{
 assert.equal(selectPartnerWorkerAgent([]),'technical-architect');
 assert.equal(selectPartnerWorkerAgent(['docs/operations.md']),'docs-maintainer');
 assert.equal(selectPartnerWorkerAgent(['tests/unit.test.ts']),'test-engineer');
 assert.equal(selectPartnerWorkerAgent(['apps/web/components/card.tsx']),'frontend-engineer');
 assert.equal(selectPartnerWorkerAgent(['packages/storage/src/schema.sql']),'database-engineer');
 assert.equal(selectPartnerWorkerAgent(['apps/api/routes/run.ts']),'backend-engineer');
 assert.equal(selectPartnerWorkerAgent(['packages/engine/src/executor.ts']),'implementation-agent');
});
test('production driver uses the governed configured provider, exact owned worker and fresh scoped policy',()=>{
 const code=readFileSync(new URL('./queue-partner-actor.ts',import.meta.url),'utf8');
 for(const guard of ['runWorkerOnce(1,{runId:childId','queuePartnerEnrollment:{claim,workerAgentId:worker.id,guideArm:guideExposure.cohort}','allowed_write_paths:writePaths','allowed_commands:writePaths.length?','sourceSubjectHash(source.root_uri,writePaths)!==sourceHash','recoverExpiredLeases:false','queuePartnerGuidePolicy(family.projectId,source.id)','recordQueuePartnerGuidePolicyTransition({projectId:family.projectId,sourceRunId:source.id,report:guidePolicy})','guidePlane:{enabled:true,sampleRate:guideSampleRate,assignment:guideExposure}','shouldStop:()=>renewalLost','proposedSourcePaths','acceptance:\'unverified\''])assert.ok(code.includes(guard),guard);
 assert.ok(code.indexOf('queuePartnerEnrollment:{claim')<code.indexOf('runWorkerOnce(1,{runId:childId'));
 assert.match(code,/phaseTimings:\{planning:planningMs,intent:intentMs,reservation:reservationMs,execution:executionMs\}/);
 assert.match(code,/if\(remembered\)await acknowledgeQueuePartnerOutcomeJournal/);
 assert.doesNotMatch(code,/requestQueuePartnerHelp|deliverRunNotifications|execFile|providerFromEnv|modelOverride:/);
 assert.doesNotMatch(code,/attachCoordinatorChild\(|registerQueuePartnerExperimentExposure\(/);
 assert.doesNotMatch(code,/providerOverride:|modelTierOverride:|strictProviderIds:/);
 assert.match(code,/partnerWorkerTeam:\{schemaVersion:1,leaderAgentId:partner\.id,workerAgentId:worker\.id/);assert.match(code,/usageAccounting:'model-route-receipts'/);
 assert.equal(code.match(/createWorkflowRun\(/gu)?.length,1,'Specialist selection must reuse the one existing recovery child, not fan out queue runs');
 assert.match(code,/createAgentTaskWorkflow\(worker\)/);assert.doesNotMatch(code,/constructDynamicWorkflow|Promise\.all\([^)]*createWorkflowRun/);
 assert.match(code,/Durable comparison index/);assert.match(code,/completed-unverified/);assert.match(code,/recordQueuePartnerMemory/);
 assert.match(code,/Revalidated project-local repair playbooks/);assert.match(code,/queuePartnerRepairPlaybooks\(comparisons,\{sourceHash,policyHash,acceptanceHash\}\)/);
 assert.match(code,/fullRecordLookup/);assert.match(code,/reuseEligible:item\.reuseEligible/);
 assert.match(code,/Regression is true only after a previously independently verified remedy/);
});

test('interrupted child recovery refuses an empty explicit project scope',async()=>{
 const {recoverInterruptedPartnerChildren}=await import('./queue-partner-actor.js');
 assert.deepEqual(await recoverInterruptedPartnerChildren({projectRoots:[]}),[]);
});
