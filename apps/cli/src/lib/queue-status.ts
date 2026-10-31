import {withClient} from '../../../../packages/storage/src/client.js';
import type {WorkflowQueueItem} from '../../../../packages/storage/src/workflow-run-types.js';
import {buildQueueCardTitle} from '../../../../packages/storage/src/run-presentation.js';
import {projectIdentitySchemaAvailable} from '../../../../packages/storage/src/project-identity.js';
import {queueLifecyclePresentation} from '../dashboard/queue-lifecycle.js';
import {sanitizeAssistantText} from '../../../../packages/conversation-contract/src/index.js';
import {proposedQueueFix} from './queue-partner-chat.js';

export type QueueStatusAttempt={runId:string;name:string;status:string;issue:string;recordedAt:string|null;dismissed:boolean};
export type QueueStatusRow={id:string;runId:string;projectId:string;projectName:string;name:string;status:string;issue:string;fix:string;recordedAt:string|null;originalStatus:string;attention:'working'|'waiting'|'approval'|'revisit'|'verify';attemptCount:number;openAttemptCount:number;completedAttemptCount:number;attempts:QueueStatusAttempt[];attemptsTruncated:boolean;familyId?:string;category?:'queue'|'history'|'acceptance'};
export type QueueStatusProject={id:string;name:string;rootUri?:string;identityId?:string};
export type QueueStatusQueueSnapshot={items:WorkflowQueueItem[];capturedAt:number;ageMs:number;refreshing:boolean;limit?:number};
export type QueueStatusReport={version:1;authority:'evidence-only';scope:'partner'|'all';observedAt:string;rows:QueueStatusRow[];projects:Array<{id:string;name:string}>;truncated:boolean;historyRows?:QueueStatusRow[];acceptanceReviewRows?:QueueStatusRow[];queueSnapshot?:{capturedAt:string;ageMs:number;refreshing:boolean;limit:number;familyCount:number}};
type SourceRow={runId:string;projectId:string;projectName:string;familyId:string;name:string;runStatus:string;currentStatus?:string|null;parentRunId?:string|null;queuedTasks:number;runningTasks:number;approvalCount:number;issue?:string|null;decision?:Record<string,unknown>|null;recordedAt?:string|null;attempts?:QueueStatusAttempt[];attemptCount?:number;openAttemptCount?:number;completedAttemptCount?:number};
export type QueueStatusSnapshot={managed:SourceRow[];queue:SourceRow[];projects:QueueStatusProject[];truncated?:boolean};
export interface QueueStatusAdapter{snapshot(projectId?:string,includeOther?:boolean):Promise<QueueStatusSnapshot>}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const clean=(v:unknown,max=1200)=>sanitizeAssistantText(typeof v==='string'?v:'',max);
type FamilyIdentity={runId:string;projectId:string;runSetId:string;startedAt:string;replacementRunId:string|null;parentRunIds:string[];idempotencyKey:string|null;source:string|null;actor:string|null;legacySources:string|null;runStatus:string;visible:boolean};
/** Historical tracking only, preserving each registered execution scope.
 * These components never determine canonical queue membership or family IDs. */
export function groupQueueStatusIdentities(runs:readonly FamilyIdentity[]){
 const byId=new Map(runs.map(r=>[r.runId,r])),parents=new Map(runs.map(r=>[r.runId,r.runId])),sets=new Map<string,string>(),requests=new Map<string,string>();
 const root=(id:string):string=>{let key=id;while(parents.get(key)!==key)key=parents.get(key)!;while(parents.get(id)!==key){const next=parents.get(id)!;parents.set(id,key);id=next;}return key;};
 const join=(a:string,b:string|null|undefined)=>{if(!b||!byId.has(b)||byId.get(a)!.projectId!==byId.get(b)!.projectId)return;const x=root(a),y=root(b);if(x!==y)parents.set(x,y);};
 for(const r of runs){const setKey=JSON.stringify([r.projectId,r.runSetId]);if(sets.has(setKey))join(r.runId,sets.get(setKey));else sets.set(setKey,r.runId);
  for(const id of [r.replacementRunId,...r.parentRunIds])join(r.runId,id);
  if(r.idempotencyKey&&r.idempotencyKey.length>=8&&r.source!==null&&r.actor!==null){const key=JSON.stringify([r.projectId,r.idempotencyKey,r.source,r.actor]);if(requests.has(key))join(r.runId,requests.get(key));else requests.set(key,r.runId);}
  const legacy=r.legacySources?.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/giu);if(legacy?.length===1)join(r.runId,legacy[0]!.toLowerCase());
 }
 const groups=new Map<string,FamilyIdentity[]>();for(const r of runs){const key=root(r.runId),members=groups.get(key);if(members)members.push(r);else groups.set(key,[r]);}
 return [...groups.values()].map(members=>{members.sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt)||a.runId.localeCompare(b.runId));const original=members[0]!,open=members.filter(r=>r.visible&&['queued','leased','running','blocked','failed'].includes(r.runStatus));return {members:members.map(r=>r.runId),open_members:open.map(r=>r.runId),related_count:members.length,version_set_id:original.runSetId,original_id:original.runId,latest_id:open.at(-1)?.runId??null,open_count:open.length};});
}
export function parseQueueStatusProject(value:string|null):string|undefined{
 if(value===null||value==='all'||value==='')return undefined;
 if(!uuid.test(value))throw Error('Choose a registered project ID.');return value.toLowerCase();
}

/** Advisory history projection only: recorded explanations do not determine
 * queue membership, authorize an action, or establish acceptance. */
export function projectQueueStatus(data:QueueStatusSnapshot,projectId?:string,now=new Date(),includeOther=true):QueueStatusReport{
 const projects=data.projects.filter(p=>uuid.test(p.id)&&(!projectId||p.id===projectId)).slice(0,200).map(p=>({id:p.id,name:clean(p.name,120)}));
 const allowed=new Set(projects.map(p=>p.id)),valid=(r:SourceRow)=>r&&uuid.test(r.runId)&&allowed.has(r.projectId)&&r.familyId.startsWith(r.projectId+':');
 const managed=data.managed.filter(valid),queue=includeOther?data.queue.filter(valid):[];
 const sources=[...managed,...queue],byRun=new Map(sources.map(r=>[`${r.projectId}:${r.runId}`,r])),parents=new Map<string,string>();
 const root=(id:string):string=>{let key=id;while(parents.has(key)&&parents.get(key)!==key)key=parents.get(key)!;return key};
 // Only explicit lineage inside the owning registered project joins families.
 for(const r of sources){if(!parents.has(r.familyId))parents.set(r.familyId,r.familyId);const parent=r.parentRunId?byRun.get(`${r.projectId}:${r.parentRunId}`):null;if(parent){if(!parents.has(parent.familyId))parents.set(parent.familyId,parent.familyId);const a=root(r.familyId),b=root(parent.familyId);if(a!==b)parents.set(a,b);}}
 const groups=new Map<string,SourceRow[]>();for(const r of sources){const key=root(r.familyId);groups.set(key,[...(groups.get(key)??[]),r]);}
 const rows=[...groups.entries()].slice(0,500).map(([familyId,members])=>{
  const r=members.find(m=>!m.parentRunId||!members.some(p=>p.runId===m.parentRunId))??members[0]!;
  const latestDecision=members.filter(m=>m.decision).sort((a,b)=>(Date.parse(b.recordedAt??'')||0)-(Date.parse(a.recordedAt??'')||0))[0];
  const counts={runningTasks:Math.max(...members.map(m=>m.runningTasks)),queuedTasks:Math.max(...members.map(m=>m.queuedTasks)),approvalCount:Math.max(...members.map(m=>m.approvalCount))};
  const current={...r,...counts,decision:latestDecision?.decision??r.decision,recordedAt:latestDecision?.recordedAt??r.recordedAt};
  const decision=current.decision??{},recordedIssue=clean(decision.why),recordedFix=clean(decision.next);
  const lifecycle=r.currentStatus??r.runStatus;
  let status=lifecycle==='completed'?'Needs verification':lifecycle==='failed'?'Failed':lifecycle==='blocked'?'Blocked':lifecycle==='cancelled'?'Cancelled':lifecycle==='queued'?'Queued':['running','leased'].includes(lifecycle)?'Running':'Unknown';
  if(current.decision){status=decision.decision==='verified'?'Review recorded':decision.decision==='active'?'Active':decision.decision==='repair-selected'?'Repair queued':decision.decision==='verifier-selected'?'Verification queued':'Held';}
  if(current.approvalCount>0)status='Awaiting approval';
  if(current.runningTasks>0)status='Running';
  else if(current.queuedTasks>0)status='Waiting';
  else if(['queued','leased','running'].includes(lifecycle))status='Needs reconciliation';
  else if(status==='Active')status='Needs reconciliation';
  const issue=(recordedIssue&&!/^family already active\b/iu.test(recordedIssue)?recordedIssue:clean(r.issue))||recordedIssue||(r.runStatus==='completed'?'Original run completed; related work still needs verified acceptance.':current.runningTasks>0?'Current task execution is recorded.':current.queuedTasks>0?'Work is queued but no task currently has a worker lease.':status==='Needs reconciliation'?'The run claims an active lifecycle but has no queued or worker-leased task.':'No concise blocker is recorded; inspect the run evidence.');
  const fix=recordedFix||(current.runningTasks>0?'Follow the existing work and its executed evidence; do not start a duplicate.':current.queuedTasks>0?'Keep the queued work visible and let the eligible worker claim it; investigate eligibility if the wait exceeds its budget.':r.runStatus==='completed'?'Review related attempts and the actual acceptance evidence; lifecycle completion alone is not acceptance.':proposedQueueFix(issue,current.approvalCount));
  const history=new Map<string,QueueStatusAttempt>();for(const m of members)for(const a of m.attempts??[{runId:m.runId,name:m.name,status:m.runStatus,issue:m.issue??'',recordedAt:m.recordedAt??null,dismissed:false}])if(uuid.test(a.runId)&&!history.has(a.runId))history.set(a.runId,{runId:a.runId,name:clean(a.name,240),status:clean(a.status,40),issue:clean(a.issue),recordedAt:a.recordedAt&&Number.isFinite(Date.parse(a.recordedAt))?new Date(a.recordedAt).toISOString():null,dismissed:Boolean(a.dismissed)});
  const attempts=[...history.values()].sort((a,b)=>(Date.parse(b.recordedAt??'')||0)-(Date.parse(a.recordedAt??'')||0)),attemptCount=Math.max(attempts.length,...members.map(m=>m.attemptCount??0));
  const suppliedOpen=members.filter(m=>m.openAttemptCount!==undefined).map(m=>m.openAttemptCount!);
  const openAttemptCount=suppliedOpen.length?Math.max(...suppliedOpen):attempts.filter(a=>!a.dismissed&&['queued','leased','running','blocked','failed'].includes(a.status)).length;
  const completedAttemptCount=Math.max(attempts.filter(a=>a.status==='completed').length,...members.map(m=>m.completedAttemptCount??0));
  const attention:QueueStatusRow['attention']=current.runningTasks>0?'working':current.approvalCount>0?'approval':current.queuedTasks>0?'waiting':r.runStatus==='completed'||decision.decision==='verified'?'verify':'revisit';
  return {id:familyId,runId:r.runId,projectId:r.projectId,projectName:clean(r.projectName,120),name:clean(r.name,240).replace(/^Agent Task [^:]{1,70}:\s*/iu,'')||'Untitled workflow',status,issue,fix,recordedAt:current.recordedAt&&Number.isFinite(Date.parse(current.recordedAt))?new Date(current.recordedAt).toISOString():null,originalStatus:clean(r.runStatus,40),attention,attemptCount,openAttemptCount,completedAttemptCount,attempts:attempts.slice(0,40),attemptsTruncated:attemptCount>40};
 });
 const unique=new Map<string,QueueStatusRow>();for(const row of rows)if(!unique.has(row.id))unique.set(row.id,row);
 const order=['Running','Waiting','Awaiting approval','Failed','Blocked','Held','Repair queued','Verification queued','Queued','Active','Needs reconciliation','Needs verification','Review recorded','Cancelled'];
 return {version:1,authority:'evidence-only',scope:includeOther?'all':'partner',observedAt:now.toISOString(),rows:[...unique.values()].sort((a,b)=>order.indexOf(a.status)-order.indexOf(b.status)||a.projectName.localeCompare(b.projectName)||a.name.localeCompare(b.name)),projects,truncated:Boolean(data.truncated)||groups.size>500||data.projects.length>200};
}

/** The queue snapshot alone decides membership and family IDs. Recorded
 * Partner decisions enrich the view; they can never add a queue member. */
export function mirrorQueueStatusReport(advisory:QueueStatusReport,source:QueueStatusQueueSnapshot,projects:QueueStatusProject[],projectId?:string,now=new Date()):QueueStatusReport{
 if(!Array.isArray(source.items)||source.items.length>500||!Number.isFinite(source.capturedAt)||!Number.isFinite(source.ageMs)||source.ageMs<0||typeof source.refreshing!=='boolean')throw Error('Canonical queue snapshot unavailable.');
 const byRoot=new Map(projects.filter(p=>p.rootUri).map(p=>[p.rootUri!,p]));
 const targetIdentity=projects.find(p=>p.id===projectId)?.identityId??projectId;
 const metadata=new Map(advisory.rows.flatMap(r=>r.attempts.map(a=>[a.runId,a] as const)));
 const queueMembers=new Set(source.items.flatMap(item=>[item.runId,...(item.familyAttempts??[]).map(a=>a.id)]));
 const queueFamilies=new Set<string>(),rows:QueueStatusRow[]=[];
 for(const item of source.items){
  const familyId=item.versionSetId??item.runSetId,owner=byRoot.get(item.projectRootUri)??(!byRoot.size?projects.find(p=>p.id===item.projectIdentityId):undefined);
  if(!owner||!uuid.test(owner.id)||!uuid.test(item.runId)||!uuid.test(familyId)||(item.projectIdentityId&&!uuid.test(item.projectIdentityId)))throw Error('Canonical queue member has no registered identity.');
  if(projectId&&owner.id!==projectId&&item.projectIdentityId!==targetIdentity)continue;
  const members=new Set([item.runId,...(item.familyAttempts??[]).map(a=>a.id)]),related=advisory.rows.filter(r=>members.has(r.runId)||r.attempts.some(a=>members.has(a.runId)));
  if(advisory.scope==='partner'&&!related.length)continue;
  const key=(item.projectIdentityId??owner.id)+':'+familyId;if(queueFamilies.has(key))throw Error('Duplicate canonical queue family.');queueFamilies.add(key);
  const history=(item.familyAttempts??[{id:item.runId,status:item.runStatus,blocker:item.blockedReason??item.failedReason??null,approvals:[]}]);
  const currentLease=item.runningTasks>0&&Boolean(item.runningLeaseExpiresAt)&&Date.parse(item.runningLeaseExpiresAt!)>now.getTime();
  const lifecycle=queueLifecyclePresentation({...item,runningTasks:currentLease?item.runningTasks:0});
  const approvalCount=history.find(a=>a.id===item.runId)?.approvals.filter(a=>a.status==='pending').length??0;
  const issue=clean(item.blockedReason??item.failedReason)||lifecycle.explanation;
  const row=projectQueueStatus({projects:[owner],managed:[{runId:item.runId,projectId:owner.id,projectName:item.projectName,familyId:owner.id+':'+familyId,name:buildQueueCardTitle(item),runStatus:item.runStatus,runningTasks:currentLease?item.runningTasks:0,queuedTasks:item.queuedTasks,approvalCount,issue}],queue:[]},undefined,now).rows[0]!;
  const attempts=history.slice(0,40).map(a=>({runId:a.id,name:metadata.get(a.id)?.name??(a.id===item.runId?clean(buildQueueCardTitle(item),240):'Workflow attempt '+a.id.slice(0,8)),status:clean(a.status,40),issue:clean(a.blocker??metadata.get(a.id)?.issue),recordedAt:metadata.get(a.id)?.recordedAt??(a.id===item.runId?item.startedAt:null),dismissed:metadata.get(a.id)?.dismissed??false}));
  const attemptCount=item.relatedRunCount??item.familyAttempts?.length??item.runSetSize??1;
  if(!Number.isSafeInteger(attemptCount)||attemptCount<1)throw Error('Invalid canonical family count.');
  rows.push({...row,id:key,familyId,category:'queue',name:clean(buildQueueCardTitle(item),240),status:lifecycle.label.charAt(0).toUpperCase()+lifecycle.label.slice(1),attention:lifecycle.key==='running'?'working':approvalCount>0?'approval':lifecycle.key==='waiting'?'waiting':'revisit',attemptCount,openAttemptCount:(item.relatedOpenRunCount??0)+(['queued','leased','running','failed','blocked'].includes(item.runStatus)?1:0),completedAttemptCount:history.filter(a=>a.status==='completed').length,attempts,attemptsTruncated:attemptCount>attempts.length});
 }
 const remaining=advisory.rows.filter(r=>!queueMembers.has(r.runId)&&!r.attempts.some(a=>queueMembers.has(a.runId)));
 const acceptanceReviewRows=remaining.filter(r=>r.openAttemptCount===0&&r.attention==='verify').map(r=>({...r,category:'acceptance' as const}));
 const reviewIds=new Set(acceptanceReviewRows.map(r=>r.id));
 const historyRows=remaining.filter(r=>!reviewIds.has(r.id)).map(r=>({...r,category:'history' as const}));
 return {...advisory,observedAt:now.toISOString(),rows,historyRows,acceptanceReviewRows,projects:projects.filter(p=>uuid.test(p.id)&&(!projectId||p.id===projectId)).map(p=>({id:p.id,name:clean(p.name,120)})).slice(0,200),truncated:advisory.truncated||source.items.length>=(source.limit??100),queueSnapshot:{capturedAt:new Date(source.capturedAt).toISOString(),ageMs:Math.max(source.ageMs,now.getTime()-source.capturedAt,0),refreshing:source.refreshing,limit:source.limit??100,familyCount:source.items.length}};
}

const defaults:QueueStatusAdapter={snapshot:async(projectId,includeOther)=>{
 const projects=await withClient(async c=>{const identity=await projectIdentitySchemaAvailable(c);return (await c.query<QueueStatusProject>(`select p.id::text,p.name,p.root_uri as "rootUri",${identity?'coalesce(l.identity_id,p.id)':'p.id'}::text as "identityId" from projects p ${identity?'left join project_identity_locations l on l.project_id=p.id':''} order by p.name,p.id limit 201`)).rows;});
 if(projectId&&!projects.some(p=>p.id===projectId))throw Error('Project not registered.');
 const identities=await withClient(async c=>(await c.query<FamilyIdentity>(`select r.id::text as "runId",r.project_id::text as "projectId",r.run_set_id::text as "runSetId",r.started_at::text as "startedAt",r.status as "runStatus",r.replacement_run_id::text as "replacementRunId",
 array_remove(array[r.evaluation_metadata->>'sourceRunId',r.evaluation_metadata->>'replayOfRunId',r.evaluation_metadata->>'repairOriginRunId',r.evaluation_metadata->>'parentRunId'],null) as "parentRunIds",
 r.evaluation_metadata->>'idempotencyKey' as "idempotencyKey",r.evaluation_metadata->>'source' source,r.evaluation_metadata->>'actor' actor,
 case when r.evaluation_metadata->>'source'='server-orchestration' and r.evaluation_metadata->>'actorRole'='operator'
   then substring(left(r.task,2500) from 'Source items: ([^' || chr(10) || ']+)') else null end as "legacySources",
 not(r.status in ('failed','blocked') and r.evaluation_metadata ? 'suiteId') and not exists(select 1 from action_receipts dismissed
   where dismissed.run_id=r.id and dismissed.action_type in ('failed_run_dismissed','failed_run_superseded') and not exists(select 1 from action_receipts reinstated
   where reinstated.run_id=r.id and reinstated.action_type='failed_run_reinstated' and reinstated.created_at>dismissed.created_at)) visible
 from workflow_runs r where ($1::uuid is null or r.project_id=$1::uuid) order by r.started_at desc,r.id desc limit 10001`,[projectId??null])).rows);
 const familyIdentities=groupQueueStatusIdentities(identities.slice(0,10000));
 const families=await withClient(async c=>(await c.query<SourceRow>(`with latest as materialized (
  select distinct on(r.project_id,r.run_set_id) r.id,r.project_id,r.run_set_id,r.status,r.task,r.construction_rationale,a.content,a.created_at
  from artifacts a join workflow_runs r on r.id=a.run_id
  join action_receipts rc on rc.run_id=r.id and rc.agent_id='workflow-orchestrator' and rc.action_type='queue_partner_decision'
   and rc.target=r.project_id::text||':'||r.run_set_id::text and rc.metadata_serialization_version=2 and rc.metadata=a.content
  where a.kind='queue_partner_decision' and a.content->>'version'='1' and a.content->>'authority'='evidence-only'
   and a.content->>'projectId'=r.project_id::text and a.content->>'runId'=r.id::text and a.content->>'familyId'=rc.target
   and a.content->>'decision'<>'outcome' and ($1::uuid is null or r.project_id=$1::uuid)
  order by r.project_id,r.run_set_id,a.created_at desc,a.uri desc
 ) select original.id::text as "runId",original.project_id::text as "projectId",p.name as "projectName",
 original.project_id::text||':'||qf.version_set_id::text as "familyId",
 left(coalesce(original.construction_rationale->'presentation'->>'title',original.task),240) name,original.status as "runStatus",
 (select x.status from workflow_runs x where x.id=qf.latest_id) as "currentStatus",
 decision.content decision,decision.created_at::text as "recordedAt",qf.related_count as "attemptCount",qf.open_count as "openAttemptCount",
 (select count(*)::int from workflow_runs x where x.id=any(qf.members) and x.status='completed') as "completedAttemptCount",
 (select count(*)::int from workflow_tasks t join workflow_runs x on x.id=t.run_id where x.project_id=original.project_id and x.id=any(qf.open_members) and x.status in ('queued','leased','running') and t.status in ('leased','running') and t.lease_expires_at>now()) as "runningTasks",
 (select count(*)::int from workflow_tasks t join workflow_runs x on x.id=t.run_id where x.project_id=original.project_id and x.id=any(qf.open_members) and x.status in ('queued','leased','running') and t.status='queued') as "queuedTasks",
 (select count(*)::int from action_approvals a join workflow_runs x on x.id=a.run_id where x.project_id=original.project_id and x.id=any(qf.open_members) and a.status='pending') as "approvalCount",
 (select left(coalesce(ar.metadata->>'reason',ar.summary),1200) from action_receipts ar
   where ar.run_id=coalesce(qf.latest_id,original.id) and ar.action_type in ('stage_blocked','stage_failed') order by ar.created_at desc limit 1) issue,
 (select jsonb_agg(jsonb_build_object('runId',a.id,'name',left(coalesce(a.construction_rationale->'presentation'->>'title',a.task),240),
   'status',a.status,'recordedAt',a.started_at,'issue',coalesce((select left(coalesce(ar.metadata->>'reason',ar.summary),1200) from action_receipts ar
     where ar.run_id=a.id and ar.action_type in ('stage_blocked','stage_failed') order by ar.created_at desc limit 1),''),
   'dismissed',exists(select 1 from action_receipts dismissed where dismissed.run_id=a.id and dismissed.action_type in ('failed_run_dismissed','failed_run_superseded')
     and not exists(select 1 from action_receipts reinstated where reinstated.run_id=a.id and reinstated.action_type='failed_run_reinstated' and reinstated.created_at>dismissed.created_at))) order by a.started_at desc,a.id desc)
   from (select * from workflow_runs x where x.id=any(qf.members) and x.project_id=original.project_id order by x.started_at desc,x.id desc limit 40) a) attempts
 from jsonb_to_recordset($3::jsonb) qf(members uuid[],open_members uuid[],related_count int,version_set_id uuid,original_id uuid,latest_id uuid,open_count int)
 join workflow_runs original on original.id=qf.original_id
 join projects p on p.id=original.project_id
 left join lateral(select l.content,l.created_at from latest l where l.id=any(qf.members) order by l.created_at desc limit 1) decision on true
 where ($1::uuid is null or original.project_id=$1::uuid) and (($2::boolean and qf.open_count>0) or decision.content is not null)
 order by (qf.open_count>0) desc,decision.created_at desc nulls last,original.started_at desc limit 501`,[projectId??null,Boolean(includeOther),JSON.stringify(familyIdentities)])).rows);
 return {managed:families.slice(0,500),queue:[],projects:projects.slice(0,200),truncated:identities.length>10000||families.length>500||projects.length>200};
}};
export async function buildQueueStatusReport(projectId?:string,adapter:QueueStatusAdapter=defaults,includeOther=true,queueSnapshot?:QueueStatusQueueSnapshot):Promise<QueueStatusReport>{
 if(projectId&&!uuid.test(projectId))throw Error('Invalid project ID.');
 const data=await adapter.snapshot(projectId,includeOther),advisory=projectQueueStatus(data,projectId,new Date(),includeOther);
 // Preserve existing Partner reasoning/selection callers. Dashboard routes
 // explicitly supply /queue's snapshot; they must not start another queue read.
 return queueSnapshot?mirrorQueueStatusReport(advisory,queueSnapshot,data.projects,projectId):advisory;
}
