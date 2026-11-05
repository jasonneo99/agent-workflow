import type {Client} from 'pg';
import {projectIdentitySchemaAvailable} from './project-identity.js';
import {appendActionReceipt} from './receipt-writer.js';

/** Explicit presentation relationship. No checkpoints, grants or evidence are inherited. */
export interface FreshRunFamilyInput {
  relatedRunId?: string;
  relatedRunReason?: string;
}

interface FreshRunFamilyLink {
  version: 1;
  kind: 'fresh-related-attempt';
  authority: 'direct-human';
  relatedRunId: string;
  projectId: string;
  relatedProjectId: string;
  identityId: string;
  actor: string;
  reason: string;
  executionAuthorityGranted: false;
  evidenceReused: false;
  originalAcceptanceChanged: false;
}

const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const executionLineageKeys=['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'];

/** Runs in createWorkflowRun's transaction after project identity registration.
 * Typed operator input is required; model prose and caller metadata cannot enroll a link. */
export async function prepareFreshRunFamilyLink(client:Client,input:FreshRunFamilyInput&{
  requester?:string;evaluationMetadata?:Record<string,unknown>;
},projectId:string):Promise<FreshRunFamilyLink|undefined> {
  const metadata=input.evaluationMetadata??{};
  if(Object.hasOwn(metadata,'queueFamilyLink'))throw Error('Use explicit relatedRunId and relatedRunReason; queueFamilyLink metadata is runtime-owned.');
  if(input.relatedRunId===undefined&&input.relatedRunReason===undefined)return undefined;
  if(typeof input.relatedRunId!=='string'||!uuid.test(input.relatedRunId)||typeof input.relatedRunReason!=='string'
    ||!input.relatedRunReason.trim()||input.relatedRunReason.length>2000)throw Error('Fresh related attempts require an exact run UUID and a bounded nonempty reason.');
  if(typeof input.requester!=='string'||!input.requester.trim()||input.requester.length>160||/[\u0000-\u001f\u007f]/u.test(input.requester))throw Error('Fresh related attempts require an explicit requester actor.');
  if(executionLineageKeys.some(key=>Object.hasOwn(metadata,key)))throw Error('Fresh display linkage cannot also claim execution or recovery lineage.');
  const related=(await client.query<{id:string;project_id:string}>(
    'select id::text,project_id::text from workflow_runs where id=$1::uuid for share',[input.relatedRunId])).rows[0];
  if(!related)throw Error('The explicitly related run does not exist.');
  let identityId=projectId;
  if(await projectIdentitySchemaAvailable(client)) {
    const ids=[...new Set([projectId,related.project_id])].sort();
    const bindings=(await client.query<{project_id:string;identity_id:string}>(
      'select project_id::text,identity_id::text from project_identity_locations where project_id=any($1::uuid[]) order by project_id for share',[ids])).rows;
    if(bindings.length!==ids.length)throw Error('Fresh related attempts require registered logical project locations.');
    identityId=bindings.find(row=>row.project_id===projectId)!.identity_id;
    if(bindings.some(row=>row.identity_id!==identityId))throw Error('Related attempts must belong to the same registered logical project.');
  } else if(related.project_id!==projectId)throw Error('Cross-worktree related attempts require registered logical project identity.');
  return {version:1,kind:'fresh-related-attempt',authority:'direct-human',relatedRunId:related.id,projectId,
    relatedProjectId:related.project_id,identityId,actor:input.requester.trim(),reason:input.relatedRunReason.trim(),
    executionAuthorityGranted:false,evidenceReused:false,originalAcceptanceChanged:false};
}

/** Append after workflow_created, in the same transaction as this new run. */
export async function recordFreshRunFamilyLink(client:Client,runId:string,link:FreshRunFamilyLink|undefined):Promise<void> {
  if(!link)return;
  await appendActionReceipt(client,{runId,agentId:'workflow-orchestrator',actionType:'fresh_run_family_linked',target:link.relatedRunId,
    summary:'Explicit fresh attempt linked for queue presentation; prior execution authority and evidence remain separate.',metadata:JSON.stringify(link)});
}
