import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'pg';
import {withClient} from '../../../../packages/storage/src/client.js';
import {discoverAuthorizedAssessmentOnClient,type AuthorizedAssessmentDiscoveryInput} from './queue-authorized-assessment.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project=id(1),assignment=id(2),source=id(3),prior=id(4),family=`${project}:${id(5)}`,root='/synthetic/project',uri=`db://workflow_runs/${prior}/assessment`;
const input=():AuthorizedAssessmentDiscoveryInput=>({reviewedRoots:[root],enrolledFamilies:new Set([family]),assignments:[],families:[{familyId:family,sourceRunId:source,projectId:project,projectRootUri:root,canonical:true,activeRunIds:['clone'],reconciliationHoldReason:'cannot lease',pendingApprovalIds:[],fileScopes:['src/file.ts'],failureFingerprint:'fingerprint',priorFingerprint:'fingerprint',repairDepth:0,verificationReady:false,originalAcceptancePresent:true,sourceEvidenceReady:true,blocker:'Historical missing evidence'}]});
const candidate=()=>({assignment_id:assignment,family_id:family,project_id:project,lane:1,file_scopes:['src/file.ts'],root_uri:root,authorization_uri:uri,blocker:'Command stderr evidence was omitted'});
test('bounded discovery selects one existing authority only after full preview, root, capacity and overlap checks',async()=>{
 let previews=0;
 const c={query:async(sql:string)=>{assert.doesNotMatch(sql,/insert|update|delete|grant/iu);if(sql.includes('limit 7'))return {rows:[]};assert.match(sql,/limit 3/);return {rows:[candidate(),candidate()]};}} as unknown as Client;
 const hooks={canonicalRoot:async(r:string,roots:readonly string[])=>r===root&&roots.includes(root),preview:async()=>{previews++;return ['clone'];}};
 assert.deepEqual(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),{assignmentId:assignment,authorizationArtifactUri:uri});assert.equal(previews,1);
 const busy=input();busy.assignments=[{id:id(9),family_id:'other',project_id:project,state:'running',role:'verifier',lane:1}];assert.equal(await discoverAuthorizedAssessmentOnClient(c,busy,hooks),null);
 const full=input();full.assignments=Array.from({length:5},(_,n)=>({id:id(n+10),family_id:`other-${n}`,project_id:project,state:'running',role:'repair',lane:n+1}));assert.equal(await discoverAuthorizedAssessmentOnClient(c,full,hooks),null);
 const overlapping=input();overlapping.families=[...overlapping.families,{...overlapping.families[0]!,familyId:'other',reconciliationHoldReason:undefined,activeRunIds:['live']}];assert.equal(await discoverAuthorizedAssessmentOnClient(c,overlapping,hooks),null);
 assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),{...hooks,preview:async()=>null}),null);
 assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),{...hooks,preview:async()=>{throw Error('Stale manifest');}}),null);
 assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),{...hooks,canonicalRoot:async()=>false}),null);
 for(const rows of [Array.from({length:7},()=>({family_id:'same',project_id:project,state:'running',role:'repair',lane:1})),[{family_id:'same',project_id:project,state:'running',role:'unknown',lane:1}],[{family_id:'same',project_id:project,state:'running',role:'repair',lane:1.5}]]){
  const malformed={query:async()=>({rows})} as unknown as Client;assert.equal(await discoverAuthorizedAssessmentOnClient(malformed,input(),hooks),null,'Truncated or malformed live occupancy fails closed');
 }
 const excessive=input();excessive.enrolledFamilies=new Set(Array.from({length:1001},(_,n)=>String(n)));assert.equal(await discoverAuthorizedAssessmentOnClient(c,excessive,hooks),null);
 for(const patch of [{file_scopes:['src/stale.ts']},{root_uri:'/synthetic/another-canonical-root'},{lane:0},{lane:1.5}]){
  const stale={query:async(sql:string)=>({rows:sql.includes('limit 7')?[]:[{...candidate(),...patch}]})} as unknown as Client;
  assert.equal(await discoverAuthorizedAssessmentOnClient(stale,input(),{...hooks,canonicalRoot:async()=>true}),null,'Candidate scope/root/lane must exactly match current family');
 }
});
test('PostgreSQL discovery excludes missing authority, consumed assessment, changed predecessor and native-proof holds',async()=>{
 await withClient(async c=>{await c.query('begin');try{
  await c.query('create temporary table projects(id uuid primary key,root_uri text) on commit drop');
  await c.query('create temporary table workflow_runs(id uuid primary key,status text) on commit drop');
  await c.query('create temporary table project_identity_locations(project_id uuid,identity_id uuid,kind text) on commit drop');
  await c.query('create temporary table queue_coordinator_assignments(id uuid,source_run_id uuid,child_run_id uuid,project_id uuid,family_id text,state text,role text,lane int,file_scopes jsonb) on commit drop');
  await c.query('create temporary table artifacts(run_id uuid,kind text,uri text,created_at timestamptz) on commit drop');
  await c.query('create temporary table action_receipts(run_id uuid,action_type text,metadata jsonb,summary text,created_at timestamptz) on commit drop');
  await c.query('insert into projects values($1,$2)',[project,root]);await c.query("insert into workflow_runs values($1,'cancelled')",[prior]);
  await c.query("insert into project_identity_locations values($1,$1,'canonical')",[project]);
  await c.query("insert into queue_coordinator_assignments values($1,$2,$3,$4,$5,'held','repair',1,$6)",[assignment,source,prior,project,family,JSON.stringify(['src/file.ts'])]);
  const hooks={canonicalRoot:async(r:string,roots:readonly string[])=>r===root&&roots.includes(root),preview:async()=>['clone']};
  assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),null,'No authorization artifact means no selection');
  await c.query("insert into artifacts values($1,'operator_history_assessment_authorized',$2,now())",[prior,uri]);
  await c.query("insert into action_receipts values($1,'stage_blocked',$2,'',now())",[prior,JSON.stringify({reason:'Missing command output evidence'})]);
  assert.deepEqual(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),{assignmentId:assignment,authorizationArtifactUri:uri});
  await c.query("insert into queue_coordinator_assignments values($1,$2,$3,$4,'outside-reviewed-family','running','verifier',1,'[]'::jsonb)",[id(20),source,prior,project]);
  assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),null,'Live global verifier is checked even if omitted from the supplied snapshot');
  await c.query('delete from queue_coordinator_assignments where id=$1',[id(20)]);
  const foreign=input();foreign.reviewedRoots=['/different'];assert.equal(await discoverAuthorizedAssessmentOnClient(c,foreign,hooks),null);
  assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),{...hooks,preview:async()=>null}),null,'Stale authority/evidence refuses selection');
  await c.query("update action_receipts set metadata=$1 where action_type='stage_blocked'",[JSON.stringify({reason:'Native host proof unavailable; native acceptance required'})]);
  assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),null,'Actual native proof cannot be supplied by another offline assessment');
  await c.query("update action_receipts set metadata=$1 where action_type='stage_blocked'",[JSON.stringify({reason:'Missing command output evidence'})]);
  await c.query("insert into action_receipts values($1,'operator_history_assessment_reserved',$2,'',now())",[source,JSON.stringify({id:assignment})]);
  assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),null,'Consumed review never redispatches');
  await c.query("delete from action_receipts where action_type='operator_history_assessment_reserved'");
  await c.query("update workflow_runs set status='blocked'");assert.equal(await discoverAuthorizedAssessmentOnClient(c,input(),hooks),null,'The later blocked assessment is not the cancelled predecessor');
 }finally{await c.query('rollback');}});
});
