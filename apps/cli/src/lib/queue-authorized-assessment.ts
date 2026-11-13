import type {Client} from 'pg';
import type {QueueCoordinatorFamily} from '../../../../packages/workflow-engine/src/queue-coordinator-plan.js';
import {withClient} from '../../../../packages/storage/src/client.js';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {previewQuarantinedHistoryAssessmentOnClient} from '../../../../packages/storage/src/history-preserving-assessment.js';
import {reviewedCanonicalRoot} from './queue-partner-recovery.js';

interface Assignment {id:string;family_id:string;project_id:string;state:string;role:string;lane:number}
export interface AuthorizedAssessmentDiscoveryInput {reviewedRoots:readonly string[];enrolledFamilies:ReadonlySet<string>;families:readonly QueueCoordinatorFamily[];assignments:readonly Assignment[]}
interface DiscoveryHooks {
 preview:typeof previewQuarantinedHistoryAssessmentOnClient;
 canonicalRoot:typeof reviewedCanonicalRoot;
}
const active=(state:string)=>['reserved','running','uncertain'].includes(state);
const externalProof=/\b(?:native(?:\s+host)?|external|physical|actual[- ]host|real[- ]host)\s+(?:acceptance|proof|verification|permission|evidence)\b|\b(?:deployment|activation|signing|credentials?|live[- ]grant)\b.{0,60}\b(?:required|missing|pending|unavailable)\b/iu;
const overlap=(left:readonly string[],right:readonly string[])=>!left.length||!right.length||left.some(a=>right.some(b=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/')));

/** Discover existing authority only. No grant, workflow, claim or intent is
 * created. Full storage preflight is repeated by explicit assessment dispatch.
 * At most three artifact candidates and one selection per idle ordinary tick.
 */
export async function discoverAuthorizedAssessmentOnClient(c:Client,input:AuthorizedAssessmentDiscoveryInput,hooks:Partial<DiscoveryHooks>={}):Promise<{assignmentId:string;authorizationArtifactUri:string}|null>{
 const h={preview:previewQuarantinedHistoryAssessmentOnClient,canonicalRoot:reviewedCanonicalRoot,...hooks};
 if(!input.enrolledFamilies.size||input.enrolledFamilies.size>1000||input.reviewedRoots.length>1000)return null;
 const liveAssignments=(await c.query(`select id::text,family_id,project_id::text,state,role,lane from queue_coordinator_assignments
  where state in ('reserved','running','uncertain') limit 7`)).rows as Assignment[];
 if(liveAssignments.length>=7||liveAssignments.some(a=>!active(a.state)||!['repair','verifier'].includes(a.role)||!Number.isInteger(a.lane)||a.lane<1||a.lane>(a.role==='verifier'?1:5)||!a.family_id||!a.project_id))return null;
 const assignments=[...input.assignments,...liveAssignments];
 if(assignments.some(a=>active(a.state)&&a.role==='verifier'))return null;
 const occupied=new Set(input.families.filter(f=>f.activeRunIds.length&&!f.reconciliationHoldReason).map(f=>f.familyId));
 for(const assignment of assignments)if(active(assignment.state))occupied.add(assignment.family_id);
 if(occupied.size>=5)return null;
 const rows=(await c.query(`select q.id::text assignment_id,q.family_id,q.project_id::text project_id,q.lane,q.file_scopes,p.root_uri,
  a.uri authorization_uri,(select coalesce(r.metadata->>'reason',r.summary) from action_receipts r
    where r.run_id=q.child_run_id and r.action_type='stage_blocked' order by r.created_at desc limit 1) blocker
  from queue_coordinator_assignments q join projects p on p.id=q.project_id
  join workflow_runs prior on prior.id=q.child_run_id and prior.status='cancelled'
  join artifacts a on a.run_id=prior.id and a.kind='operator_history_assessment_authorized'
  where q.state='held' and q.role='repair' and q.family_id=any($1::text[])
   and exists(select 1 from project_identity_locations l where l.project_id=q.project_id and l.identity_id=q.project_id and l.kind='canonical')
   and not exists(select 1 from action_receipts used where used.run_id=q.source_run_id
    and used.action_type='operator_history_assessment_reserved' and used.metadata->>'id'=q.id::text)
  order by a.created_at desc,a.uri limit 3`,[[...input.enrolledFamilies]])).rows;
 for(const row of rows){
  if(!input.enrolledFamilies.has(row.family_id)||externalProof.test(String(row.blocker??''))||!await h.canonicalRoot(row.root_uri,input.reviewedRoots))continue;
  const family=input.families.find(f=>f.familyId===row.family_id&&f.projectId===row.project_id);
  if(!family||!family.canonical||family.pendingApprovalIds.length||!family.sourceEvidenceReady||!family.originalAcceptancePresent
   ||row.root_uri!==family.projectRootUri||!Number.isInteger(row.lane)||row.lane<1||row.lane>5
   ||!Array.isArray(row.file_scopes)||row.file_scopes.some((p:unknown)=>typeof p!=='string')
   ||new Set(row.file_scopes).size!==row.file_scopes.length||acceptanceDigest([...row.file_scopes].sort())!==acceptanceDigest([...family.fileScopes].sort())
   ||assignments.some(a=>active(a.state)&&(a.family_id===row.family_id||(a.role==='repair'&&a.lane===row.lane)))
   ||input.families.some(other=>other.familyId!==family.familyId&&other.projectId===family.projectId&&other.activeRunIds.length&&overlap(family.fileScopes,other.fileScopes)))continue;
  const ignored=await h.preview(c,{assignmentId:row.assignment_id,authorizationArtifactUri:row.authorization_uri}).catch(()=>null);
  if(!ignored||ignored.length!==family.activeRunIds.length||new Set(ignored).size!==ignored.length||family.activeRunIds.some(id=>!ignored.includes(id)))continue;
  return {assignmentId:row.assignment_id,authorizationArtifactUri:row.authorization_uri};
 }
 return null;
}
export const discoverAuthorizedAssessment=(input:AuthorizedAssessmentDiscoveryInput)=>withClient(async c=>{
 await c.query('begin');try{return await discoverAuthorizedAssessmentOnClient(c,input);}finally{await c.query('rollback');}
});
