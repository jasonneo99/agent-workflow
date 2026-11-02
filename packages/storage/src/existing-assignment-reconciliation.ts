import type {Client} from 'pg';
import {inspectVerifierReassessment} from './verifier-reassessment.js';
import {inspectExecutionRecipeAdoption} from './execution-recipe-adoption.js';
import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';
import {appendActionReceipt} from './receipt-writer.js';
import {enqueueRunNotification} from './run-notifications.js';
import type {StructuredAcceptanceContract} from '../../model-providers/src/types.js';
import {observeHistoricalSourceEffects,type HistoricalSourceReview} from './historical-source-observation.js';

/** Operator-only input. Never expose this operation as a worker/model tool.
 * The caller must possess direct human authority for these exact existing IDs.
 * Preview is a compare-and-swap commitment, not authority by itself.
 */
export interface ExistingAssignmentRequest {
 assignmentId:string; runId:string; expectedFence:string; owner:string; intentFence:string;
 sourcePaths:string[]; commands:string[]; authorizationReference:string; actor:string; reason:string;
 /** Separate direct-human repaired-resume authority; never callback authority. */
 repairProofUri?:string;
 /** Explicit one-time prospective recipe adoption after a task-bound PTY denial. */
 executionRecipe?:{failedCommandUri:string;commands:string[]};
 /** Separate one-time direct-human verifier authority; never a repair role. */
 verifierReassessment?:{authorizationUri:string};
 /** Explicit operator review of a retained, cancelled sibling branch. Never
  * selected automatically from callback text or a stale worker's metadata. */
 cancelledBranch?:{predecessorRunId:string;predecessorFence:string};
 /** Explicit vacant repair lane; never take over an occupied historical lane. */
 lane?:number;
}
const exactPaths=(paths:string[])=>paths.length>0&&paths.length<=1000&&new Set(paths).size===paths.length
 &&paths.every(p=>typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!/[\\*?\[\]{}]/u.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..'));

/** Operator-only prospective admission. This is a single additional source
 * phase, not a refund of any historical repair/reassessment budget. */
export interface ProspectiveSourcePhaseRequest {
 runId:string;assignmentId:string;expectedFence:string;expectedStateVersion:string;
 phaseId:string;owner:string;intentFence:string;actor:string;reason:string;
 sourcePaths:string[];writePaths:string[];commands:string[];goal:string;lane:number;
 /** One separately approved correction of a pre-write checkpoint-policy refusal. */
 correctedAttempt?:true;
 /** Separately authorized amendment after both pre-write capability refusals. */
 amendedAttempt?:{verificationCommand:string;rootFinalizationPaths:string[];environmentProfile:string};
 /** One human-approved budget, at most three attempts, without resetting tasks. */
 continuation?:{ordinal:number;readonlyPaths:string[];workerGoal:string};
}
export async function previewProspectiveSourcePhaseOnClient(c:Client,input:ProspectiveSourcePhaseRequest) {
 const {loadProjectConfig,loadWorkflows}=await import('../../agent-registry/src/loaders.js');
 const {projectConfigSchema}=await import('../../agent-registry/src/schemas.js');
 const {assertFilePathAllowed}=await import('../../local-tools/src/file-writer.js');
 const {assertFileReadAllowed}=await import('../../local-tools/src/file-reader.js');
 const {assertCommandAllowed}=await import('../../local-tools/src/command-executor.js');
 const {findAgentWorkflowRoot}=await import('../../runtime-root/src/index.js');
 const {assertRepairCommitEnabled,REPAIR_COMMIT_COMMAND}=await import('../../run-environments/src/repair-checkpoint.js');
 const {ENVIRONMENT_COMMAND,planRunEnvironment}=await import('../../run-environments/src/index.js');
 const {queueWorkingOccupancyOnClient}=await import('./queue-coordinator.js');
 if(input.amendedAttempt&&!input.correctedAttempt)throw Error('An amendment must retain the corrected phase');
 if(input.continuation&&(!input.amendedAttempt||!Number.isInteger(input.continuation.ordinal)||input.continuation.ordinal<1||input.continuation.ordinal>3||
  !exactPaths(input.continuation.readonlyPaths)||input.continuation.readonlyPaths.length>16||
  input.continuation.readonlyPaths.some(p=>!p.endsWith('.py')||p.startsWith('.')||input.writePaths.includes(p))||
  !input.continuation.workerGoal||input.continuation.workerGoal.length>8192))throw Error('Exact bounded source continuation required');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.phaseId)||!input.owner||!input.actor||!input.reason||
  !input.goal||input.goal.length>8192||!exactPaths(input.sourcePaths)||input.sourcePaths.length>128||
  !exactPaths(input.writePaths)||input.writePaths.some(p=>!input.sourcePaths.includes(p)||
   p==='AGENTS.md'||p==='.agent-workflow/project.yaml')||!input.commands.length||input.commands.length>32||
  new Set(input.commands).size!==input.commands.length||input.commands.some(x=>typeof x!=='string'||x.includes('*'))||
  !input.commands.includes('git diff --check')||!Number.isInteger(input.lane)||input.lane<1||input.lane>5)
  throw Error('Exact bounded prospective source phase required');
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const row=(await c.query(`select r.*,r.id::text run_key,r.project_id::text project_key,p.root_uri,
  q.id::text assignment_key,q.project_id::text assignment_project,q.fence::text assignment_fence,q.state assignment_state,q.role,q.owner prior_owner,
  q.intent_fence prior_intent_fence,q.family_id,q.source_run_id::text source_id,q.file_scopes
  from workflow_runs r join projects p on p.id=r.project_id join queue_coordinator_assignments q on q.child_run_id=r.id
  where r.id=$1 and q.id=$2 for update of r,q,p`,[input.runId,input.assignmentId])).rows[0];
 if(!row||row.assignment_project!==row.project_key||!['blocked','failed'].includes(row.status)||
  !(input.correctedAttempt?['held','running']:['held']).includes(row.assignment_state)||row.role!=='repair'||
  row.assignment_fence!==input.expectedFence||String(row.state_version)!==input.expectedStateVersion||row.lease_owner||
  row.lease_expires_at&&new Date(row.lease_expires_at).getTime()>Date.now()||
  row.evaluation_metadata?.queueCoordinatorClaimId!==input.assignmentId||
  String(row.evaluation_metadata?.queueCoordinatorFence)!==input.expectedFence||
  row.evaluation_metadata?.sourceRunId!==row.source_id||await fs.realpath(row.root_uri)!==row.root_uri||
  /(^|\/)(vendor|node_modules)(\/|$)/u.test(row.root_uri))throw Error('Exact held canonical run and assignment required');
 const source=(await c.query('select project_id::text project_key,run_set_id::text run_set from workflow_runs where id=$1 for update',[row.source_id])).rows[0];
 if(!source||source.project_key!==row.project_key||row.family_id!==row.project_key+':'+source.run_set)
  throw Error('Prospective source phase must retain exact original project and family');
 if(!(await c.query("select 1 from project_identity_locations where project_id=$1 and identity_id=$1 and kind='canonical'",[row.project_key])).rowCount)
  throw Error('Canonical project registration required');
 const admitted=await c.query("select 1 from action_receipts where run_id=$1 and action_type='prospective_source_phase_admitted'",[input.runId]);
 if(admitted.rowCount&&!input.correctedAttempt)
  throw Error('One-time prospective source phase already consumed');
 if(input.correctedAttempt){
  const corrected=(await c.query("select 1 from action_receipts where run_id=$1 and action_type='prospective_source_phase_corrected_once'",[input.runId])).rowCount;
  const amended=(await c.query("select 1 from action_receipts where run_id=$1 and action_type='prospective_source_phase_amended_once'",[input.runId])).rowCount;
  const continued=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='prospective_source_phase_continued' order by created_at",[input.runId])).rows;
  if(admitted.rowCount!==1||row.evaluation_metadata?.prospectiveSourcePhase?.phaseId!==input.phaseId||
   (input.continuation?corrected!==1||amended!==1||continued.length>=3||input.continuation.ordinal!==continued.length+1:
    input.amendedAttempt?corrected!==1||amended!==0:corrected!==0))
   throw Error('One corrected attempt on the same admitted phase only');
  const original=(await c.query(`select a.content from artifacts a join action_receipts r on r.run_id=a.run_id and r.target=a.uri
   and r.metadata=a.content and r.agent_id='workflow-orchestrator' and r.action_type='operator_prospective_source_phase_authorized'
   where a.run_id=$1 and a.uri=$2 and a.kind='prospective_source_phase_authorization'`,[input.runId,row.evaluation_metadata.prospectiveSourcePhase.authorizationUri])).rows;
  if(original.length!==1)throw Error('Original phase authority unavailable');
  for(const key of ['phaseId','assignmentId','goal','lane'] as const)
   if(acceptanceDigest(input[key])!==acceptanceDigest(original[0].content.manifest[key]))throw Error('Correction cannot broaden the admitted phase');
  const previous=original[0].content.manifest;
  if(acceptanceDigest(input.sourcePaths)!==acceptanceDigest([...previous.sourcePaths,...(input.continuation?.readonlyPaths??[])]))
   throw Error('Continuation may add only its bound read-only dependencies');
  if(input.continuation&&continued.some(r=>acceptanceDigest(r.metadata.continuation)!==acceptanceDigest({...input.continuation,ordinal:r.metadata.continuation.ordinal})))
   throw Error('Continuation budget scope cannot change');
  if(input.amendedAttempt){
   const amendment=input.amendedAttempt,match=/^python3 -m unittest discover -s tests -p (test_[A-Za-z0-9_]+\.py) -v$/u.exec(amendment.verificationCommand);
   if(!match||!input.writePaths.includes('tests/'+match[1])||!Array.isArray(amendment.rootFinalizationPaths)||
    (amendment.rootFinalizationPaths.length>0&&!exactPaths(amendment.rootFinalizationPaths))||
    amendment.rootFinalizationPaths.some(p=>!p.startsWith('.agent-workflow/receipts/')||!previous.writePaths.includes(p))||
    acceptanceDigest(input.writePaths)!==acceptanceDigest(previous.writePaths.filter((p:string)=>!amendment.rootFinalizationPaths.includes(p)))||
    input.writePaths.some(p=>p.startsWith('.agent-workflow/'))||
    acceptanceDigest(input.commands)!==acceptanceDigest([...previous.commands,amendment.verificationCommand]))
    throw Error('Amendment must narrow writes and add only its exact focused regression');
  }else for(const key of ['writePaths','commands'] as const)
   if(acceptanceDigest(input[key])!==acceptanceDigest(previous[key]))throw Error('Correction cannot broaden the admitted phase');
 }
 const intent=(await c.query(`select file_scopes,expires_at from work_intents where project_id=$1 and owner=$2
  and fencing_token::text=$3 and expires_at>clock_timestamp() for update`,[row.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest([...intent.file_scopes].sort())!==acceptanceDigest([...input.sourcePaths].sort()))throw Error('Fresh exact prospective work intent required');
 if((await c.query(`select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3
  and expires_at>clock_timestamp()`,[row.project_key,row.prior_owner,row.prior_intent_fence])).rowCount)throw Error('Prior assignment still owns a live intent');
 const tasks=(await c.query('select * from workflow_tasks where run_id=$1 order by id for update',[input.runId])).rows;
 if(!tasks.length||tasks.some(t=>['queued','leased','running'].includes(t.status)||t.lease_expires_at&&new Date(t.lease_expires_at).getTime()>Date.now()))throw Error('Historical tasks must be terminal and unleased');
 if((await c.query(`select 1 from action_approvals where run_id=$1 and status in ('pending','executing')
  union all select 1 from side_effect_receipts where project_id=$2 and status is distinct from 'completed' limit 1`,[input.runId,row.project_key])).rowCount)
  throw Error('Outstanding approval or uncertain effect must be reconciled first');
 const others=(await c.query("select id::text,project_id::text project_key,role,lane,family_id,file_scopes from queue_coordinator_assignments where id<>$1 and state in ('reserved','running','uncertain') for update",[input.assignmentId])).rows;
 if(others.some(q=>q.family_id===row.family_id||q.role===row.role&&q.lane===input.lane||q.project_key===row.project_key&&
  (!Array.isArray(q.file_scopes)||!q.file_scopes.length||q.file_scopes.some((a:string)=>input.sourcePaths.some(b=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/')))))||
  (await queueWorkingOccupancyOnClient(c)).count>=5)throw Error('Prospective phase conflicts with existing ownership or capacity');
 const current=await loadProjectConfig(row.root_uri);
 for(const relative of input.sourcePaths){
  if(input.continuation?.readonlyPaths.includes(relative)){assertFileReadAllowed(relative,current);assertFileReadAllowed(relative,row.policy_snapshot);continue;}
  assertFilePathAllowed(relative,current);
  assertFilePathAllowed(relative,{...row.policy_snapshot,actions:{...row.policy_snapshot.actions,allowed_write_paths:input.sourcePaths}});
 }
 const tests=input.commands.filter(command=>/\b(?:unittest|pytest)\b|^npm (?:test|run (?:test|check))\b|^node .*--test\b/u.test(command));
 if(!tests.length)throw Error('Prospective phase needs a behavioral verification command');
 for(const command of input.commands){
  const addition=input.amendedAttempt?.verificationCommand===command?[command]:[];
  for(const base of [current,row.policy_snapshot])assertCommandAllowed(command,{...base,actions:{...base.actions,allowed_commands:[...base.actions.allowed_commands,...addition]}});
 }
 const priorContract=await reconciledExecutionContract(c,input.runId,row.evaluation_metadata);
 if(!priorContract?.sourcePaths?.length||priorContract.sourcePaths.some(p=>!input.sourcePaths.includes(p)))throw Error('Original acceptance source scope must remain retained');
 const prefix='source-phase-'+input.phaseId,profile='source-phase-'+input.phaseId;
 const repair=(await loadWorkflows(findAgentWorkflowRoot(import.meta.url))).find(w=>w.id==='repair-blocked-item');
 if(!repair||repair.stages.length!==3||repair.stages[0]?.agent!=='implementation-agent'||
  repair.stages[1]?.agent!=='test-engineer'||repair.stages[0].runtime_operation||repair.stages[1].runtime_operation||
  !repair.stages[0].checkpoint_after||repair.stages[1].pattern?.type!=='verifier'||
  repair.stages[2]?.runtime_operation!=='integrate-source')throw Error('Trusted prepared source workflow unavailable');
 const stages=repair.stages.map((stage,index)=>({...stage,id:prefix+'-'+stage.id,
  goal:index===0?(input.continuation?.workerGoal??input.goal)+'\n'+stage.goal:stage.goal,
  depends_on:repair.stages.slice(0,index).map(s=>prefix+'-'+s.id)}));
 if(!Array.isArray(row.workflow_snapshot?.stages)||(!input.correctedAttempt&&stages.some(stage=>row.workflow_snapshot.stages.some((old:any)=>old.id===stage.id))))
  throw Error('Prospective stage identity conflicts with retained workflow');
 if(input.correctedAttempt){
  const retained=row.workflow_snapshot.stages.filter((stage:any)=>stages.some(s=>s.id===stage.id));
  const comparable=(values:any[])=>values.map((s,index)=>index===0&&input.continuation?{...s,goal:'explicitly amended worker obligation'}:s);
  if(acceptanceDigest(comparable(retained))!==acceptanceDigest(comparable(stages)))throw Error('Correction requires unchanged phase stages');
  const phaseTasks=stages.map(stage=>tasks.filter(t=>t.stage_id===stage.id));
  if(phaseTasks.some(found=>found.length!==1)||phaseTasks[0]![0].status!=='blocked'||phaseTasks[0]![0].attempts!==(input.continuation?2+input.continuation.ordinal:input.amendedAttempt?2:1)||
   phaseTasks.slice(1).some(found=>found[0].status!=='cancelled'||found[0].attempts!==0))throw Error('Correction requires the single pre-write attempt');
  const failure=(await c.query(`select content from artifacts where run_id=$1 and task_id=$2 and kind='stage_output'`,[input.runId,phaseTasks[0]![0].id])).rows;
  if(!input.continuation&&(failure.length!==1||failure[0].content.phase!=='runtime-preparation'||
   failure[0].content.blockedReason!==(input.amendedAttempt?`Run environments require the exact project capability: ${ENVIRONMENT_COMMAND}`:"Repair commits are not enabled by the owning project's exact capability.")))
   throw Error('Only the checkpoint-capability preparation refusal can be corrected');
  // No provider or product-write authority may have been exercised. Retained
  // stage output and the receipt chain remain immutable after the retry.
  if(!input.continuation&&(await c.query(`select 1 from action_receipts where run_id=$1 and agent_id=$2
   and action_type in ('local_file_write','local_command','provider_invocation','source_checkpoint_created')
   and created_at>(select min(created_at) from action_receipts where run_id=$1 and action_type='prospective_source_phase_admitted')`,
   [input.runId,stages[0]!.agent])).rowCount)throw Error('Correction requires no source execution effects');
 }
 assertRepairCommitEnabled(current);
 assertCommandAllowed(ENVIRONMENT_COMMAND,current);
 const environmentPaths=input.amendedAttempt?input.sourcePaths.filter(p=>!p.startsWith('.agent-workflow/')):input.sourcePaths;
 const suppliedProfile=input.amendedAttempt?current.execution.environments?.profiles[input.amendedAttempt.environmentProfile]:undefined;
 if(input.amendedAttempt&&(!suppliedProfile||suppliedProfile.kind!=='container'||suppliedProfile.build_network!=='none'||
  suppliedProfile.setup.length||Object.keys(suppliedProfile.env).length||Object.keys(suppliedProfile.services).length))
  throw Error('Amendment needs an existing offline container profile without setup, environment or services');
 const policy=projectConfigSchema.parse({...current,actions:{...current.actions,allowed_commands:[...input.commands,REPAIR_COMMIT_COMMAND,ENVIRONMENT_COMMAND],
  allowed_write_paths:input.writePaths,blocked_commands:[...new Set([...current.actions.blocked_commands,...(row.policy_snapshot.actions.blocked_commands??[])])],
  blocked_write_paths:[...new Set([...current.actions.blocked_write_paths,...(row.policy_snapshot.actions.blocked_write_paths??[])])],isolate_command_writes:true},execution:{...current.execution,
  repair_commits:{enabled:true,stages:[stages[0]!.id]},environments:{docker_context:current.execution.environments?.docker_context,default_profile:profile,profiles:{[profile]:{
   ...(suppliedProfile?{kind:'container',platform:suppliedProfile.platform,image:suppliedProfile.image}:{kind:'native',platform:`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`}),
   source_paths:environmentPaths,readiness:suppliedProfile?[{argv:['python3','-c','import os; assert hasattr(os, "memfd_create"); print("linux-stdlib-ready")'],expect_output:'linux-stdlib-ready'}]:[{argv:['git','diff','--check']}],build_network:'none',
   verification:[{commands:input.amendedAttempt?[input.amendedAttempt.verificationCommand]:tests,format:tests.every(x=>x.includes('unittest'))?'unittest':tests.every(x=>x.includes('pytest'))?'pytest':'node-test',minimum_tests:1}],
   limits:{timeout_ms:Math.min(current.actions.command_timeout_ms,600000),max_source_bytes:67108864,max_files:1000}
  }}}}});
 if(current.execution.repair_commits?.enabled!==true)throw Error('Current project must authorize source checkpoints');
 assertRepairCommitEnabled(policy);
 // Exercise the actual planner's capability, source and profile checks before
 // consuming human execution authority; this does not execute a command.
 await planRunEnvironment({cwd:row.root_uri,project:policy,context:{runId:input.runId,
  workflowId:row.workflow_id??'prospective-source',stageId:stages[0]!.id,profile}});
 const phasePaths=input.continuation?environmentPaths:input.sourcePaths;
 const sourceHash=await sourceSubjectHash(row.root_uri,phasePaths);
 const phaseContract:StructuredAcceptanceContract={version:1,contractId:prefix,projectId:row.project_key,
  originRunId:input.runId,taskHash:acceptanceDigest(row.task),sourcePaths:phasePaths,subjectHash:sourceHash,
  deliverables:[{id:'approved-source-phase',description:input.continuation?.workerGoal??input.goal,status:'pending',receipts:{},gaps:[],requiredGates:['implementation','verification','packaging','supervision']}]};
 const manifest={version:1,operation:input.continuation?'continue-existing-source-phase-bounded':input.amendedAttempt?'amend-existing-source-phase-once':input.correctedAttempt?'correct-existing-source-phase-once':'continue-existing-run-source-phase',authority:'direct-human',approvalDecision:'approved',maxAttempts:input.continuation?3:1,
  ...input,projectId:row.project_key,taskHash:acceptanceDigest(row.task),sourceHash,currentPolicyHash:acceptanceDigest(current),
  priorPolicyHash:acceptanceDigest(row.policy_snapshot),policyHash:acceptanceDigest(policy),priorContractHash:acceptanceDigest(priorContract),
  taskSnapshotHash:acceptanceDigest(tasks),workflowSnapshotHash:acceptanceDigest(row.workflow_snapshot),
  phaseStagesHash:acceptanceDigest(stages),intentExpiresAt:new Date(intent.expires_at).toISOString()};
 return {digest:acceptanceDigest(manifest),manifest,snapshot:{row,tasks,policy,priorContract,phaseContract,stages}};
}

/** The caller is the independently authenticated human control surface. Never
 * register this as an agent tool or use callback text to mint its authorization. */
export async function admitProspectiveSourcePhaseOnClient(c:Client,input:ProspectiveSourcePhaseRequest,expectedDigest:string,authorizationUri:string) {
 await c.query('savepoint prospective_source_phase_admission');
 try{
 const preview=await previewProspectiveSourcePhaseOnClient(c,input);
 if(preview.digest!==expectedDigest)throw Error('Prospective phase changed after preview');
 const correction=input.correctedAttempt===true;
 const records=(await c.query(`select a.content,a.created_at from artifacts a join action_receipts r on
  r.run_id=a.run_id and r.target=a.uri and r.metadata=a.content and r.receipt_hash is not null
  and r.agent_id='workflow-orchestrator' and r.action_type=$3
  where a.run_id=$1 and a.uri=$2 and a.kind=$4`,[input.runId,authorizationUri,
   input.continuation?'operator_prospective_source_phase_continuation_authorized':input.amendedAttempt?'operator_prospective_source_phase_amendment_authorized':correction?'operator_prospective_source_phase_correction_authorized':'operator_prospective_source_phase_authorized',
   input.continuation?'prospective_source_phase_continuation_authorization':input.amendedAttempt?'prospective_source_phase_amendment_authorization':correction?'prospective_source_phase_correction_authorization':'prospective_source_phase_authorization'])).rows;
 const grant=records.length===1?records[0].content:null,expiry=Date.parse(grant?.expiresAt),now=Date.now();
 if(!grant||acceptanceDigest(grant.manifest)!==preview.digest||grant.previewDigest!==expectedDigest||
  !/^human-message:[^\s]+$/u.test(grant.instructionReference??'')||typeof grant.instructionText!=='string'||
  !grant.instructionText.length||grant.instructionText.length>8192||createHash('sha256').update(grant.instructionText).digest('hex')!==grant.instructionSha256||
  !Number.isFinite(expiry)||expiry<=now||expiry>new Date(records[0].created_at).getTime()+3600000||
  expiry>Date.parse(preview.manifest.intentExpiresAt))throw Error('Fresh exact direct-human prospective authorization required');
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 for(const id of new Set([input.runId,preview.snapshot.row.source_id]))if(!(await verifyRunReceiptChainOnClient(c,id)).valid)throw Error('Original receipt chain invalid');
 const {row,tasks,policy,priorContract,phaseContract,stages}=preview.snapshot;
 const fresh=(await c.query(`update queue_coordinator_assignments set owner=$2,intent_fence=$3,file_scopes=$4::jsonb,
  lane=$5,fence=nextval(pg_get_serial_sequence('queue_coordinator_assignments','fence')),state='running',
  reason='Explicit one-time prospective source phase; historical attempts retained',updated_at=clock_timestamp()
  where id=$1 and fence=$6::bigint and state=$7 returning fence::text`,[input.assignmentId,input.owner,input.intentFence,JSON.stringify(input.sourcePaths),input.lane,input.expectedFence,row.assignment_state])).rows[0];
 if(!fresh)throw Error('Prospective assignment fence changed');
 const uri=`db://workflow_runs/${input.runId}/existing_assignment_reconciled/${randomUUID()}`;
 const record={version:1,runId:input.runId,assignmentId:input.assignmentId,fence:fresh.fence,contract:phaseContract,
  acceptanceScope:'approved-source-phase-only',originalAcceptanceUnchanged:true,authorizationUri,authorizationHash:acceptanceDigest(grant),
  previewDigest:preview.digest,priorAssignment:{fence:input.expectedFence,owner:row.prior_owner,intentFence:row.prior_intent_fence},
  priorRun:row,priorTasks:tasks,priorTaskOutputs:(await c.query("select * from artifacts where run_id=$1 and kind='stage_output'",[input.runId])).rows,priorContract};
 await c.query("insert into artifacts(run_id,kind,uri,content)values($1,'existing_assignment_reconciled',$2,$3::jsonb)",[input.runId,uri,JSON.stringify(record)]);
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'existing_assignment_reconciled',target:uri,
  summary:'Admitted a scoped prospective source phase; original blocked stages, attempts and acceptance remain unchanged.',metadata:JSON.stringify(record)});
 const metadata={...row.evaluation_metadata,queueCoordinatorFence:fresh.fence,workIntent:{owner:input.owner,fencingToken:input.intentFence},
  existingAssignmentReconciliationUri:uri,coordinatorReconciliationContract:phaseContract,noAutomaticRepeat:true,
  taskGrant:{sourceWritePaths:input.writePaths},prospectiveSourcePhase:correction?
   {...row.evaluation_metadata.prospectiveSourcePhase,...(input.amendedAttempt?{amendmentAuthorizationUri:authorizationUri}:{correctionAuthorizationUri:authorizationUri})}:
   {phaseId:input.phaseId,authorizationUri,originalContract:priorContract,originalTaskIds:tasks.map(t=>t.id)},
  executionPipeline:{version:1,required:true,sourceChanges:true,isolation:'worktree',preparedOnly:false,
   sourcePaths:phaseContract.sourcePaths,checkpointStageIds:[stages[0]!.id]}};
 const workflow=correction?{...row.workflow_snapshot,stages:row.workflow_snapshot.stages.map((old:any)=>stages.find(s=>s.id===old.id)??old)}:{...row.workflow_snapshot,execution:{kind:'source-change'},stages:[...row.workflow_snapshot.stages,...stages]};
 const updated=(await c.query(`update workflow_runs set status='queued',state_version=state_version+1,finished_at=null,
  evaluation_metadata=$2::jsonb,policy_snapshot=$3::jsonb,policy_snapshot_hash=$4,workflow_snapshot=$5::jsonb,
  workflow_definition_hash=$6 where id=$1 and state_version=$7::bigint and status=$8 returning state_version::text`,
  [input.runId,JSON.stringify(metadata),JSON.stringify(policy),acceptanceDigest(policy),JSON.stringify(workflow),acceptanceDigest(workflow),input.expectedStateVersion,row.status])).rows[0];
 if(!updated)throw Error('Prospective run state changed');
 if(correction){
  for(const stage of stages)if((await c.query(`update workflow_tasks set status='queued',worker_id=null,lease_expires_at=null,
   finished_at=null,available_at=clock_timestamp() where run_id=$1 and stage_id=$2 and status in ('blocked','cancelled')`,[input.runId,stage.id])).rowCount!==1)
   throw Error('Corrected task identity changed');
 }else{
 for(const stage of stages)await c.query(`insert into workflow_tasks(id,run_id,stage_id,agent_id,status,attempts,available_at,idempotency_key)
  values($1,$2,$3,$4,'queued',0,clock_timestamp(),$5)`,[randomUUID(),input.runId,stage.id,stage.agent,`${input.runId}:${stage.id}:${stage.agent}`]);
 for(const destination of stages)for(const sourceId of destination.depends_on??[]){
  const source=stages.find(stage=>stage.id===sourceId);
  if(!source)throw Error('Prospective handoff source missing');
  const handoff=(await c.query(`insert into workflow_handoffs(run_id,sender_agent_id,receiver_agent_id,source_stage_id,destination_stage_id,
   transferred_artifacts,context_summary,acceptance_criteria,idempotency_key)
   values($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7::jsonb,$8) returning id::text`,
   [input.runId,source.agent,destination.agent,source.id,destination.id,`Transfer ${source.output} from ${source.id} to ${destination.id}.`,
    JSON.stringify(destination.acceptance_criteria??[destination.goal]),`${source.id}:${destination.id}`])).rows[0];
  await c.query(`insert into workflow_handoff_events(handoff_id,run_id,status,actor_agent_id,metadata)
   values($1,$2,'proposed',$3,$4::jsonb)`,[handoff.id,input.runId,source.agent,JSON.stringify({generatedFromWorkflowDefinition:true,phaseId:input.phaseId})]);
 }
 }
 const brief=`Approved prospective source phase ${input.phaseId}. Same run, no new wrapper.\n${input.continuation?.workerGoal??input.goal}\nExact source write paths: ${input.writePaths.join(', ')}. Exact commands: ${input.commands.join('; ')}.\n${input.amendedAttempt?`Approved amendment: root separately finalizes ${input.amendedAttempt.rootFinalizationPaths.join(', ')}; do not write these private receipts. Required zero-skip candidate verification: ${input.amendedAttempt.verificationCommand}, in the disposable offline Linux environment. The original three checks remain separate broader source gates.\n`:''}Use the required isolated prepared pipeline. Root owns intent ${input.owner}/${input.intentFence}; do not acquire a competing intent. Historical blocked tasks and original acceptance are retained, not delivered by this phase. No deployment, service restart, credentials, terminal features, policy edits, new workflow, or direct Git commit commands. Let the runtime commit/verify/integrate the exact source candidate. Phase authorization: ${authorizationUri}.`;
 await c.query("insert into artifacts(run_id,kind,uri,content,created_at)values($1,'compiled_brief',$2,$3::jsonb,clock_timestamp())",[input.runId,uri+'/brief',JSON.stringify({text:brief,assignmentFence:fresh.fence,contractDigest:acceptanceDigest(phaseContract)})]);
 await c.query(`insert into workflow_run_transitions(run_id,from_status,to_status,state_version,lease_epoch,actor,reason,idempotency_key,metadata)
  values($1,$2,'queued',$3::bigint,$4::bigint,$5,$6,$7,$8::jsonb)`,[input.runId,row.status,updated.state_version,row.lease_epoch,input.actor,input.reason,
  (input.continuation?'prospective-source-phase-continuation:'+input.continuation.ordinal+':':input.amendedAttempt?'prospective-source-phase-amendment:':correction?'prospective-source-phase-correction:':'prospective-source-phase:')+input.runId,JSON.stringify({authorizationUri,phaseId:input.phaseId,assignmentFence:fresh.fence})]);
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:input.continuation?'prospective_source_phase_continued':input.amendedAttempt?'prospective_source_phase_amended_once':correction?'prospective_source_phase_corrected_once':'prospective_source_phase_admitted',target:authorizationUri,
  summary:'Explicitly authorized source work queued on the same phase; historical retries and original blocked tasks retained.',metadata:JSON.stringify({phaseId:input.phaseId,previewDigest:preview.digest,assignmentFence:fresh.fence,...(input.continuation?{continuation:input.continuation}:{}),originalAcceptanceUnchanged:true})});
 await c.query('release savepoint prospective_source_phase_admission');
 return {runId:input.runId,fence:fresh.fence,intentFence:input.intentFence,artifactUri:uri,phaseId:input.phaseId};
 }catch(error){
  await c.query('rollback to savepoint prospective_source_phase_admission');
  await c.query('release savepoint prospective_source_phase_admission');throw error;
 }
}

/** A new direct human source phase is not a refund of an old repair budget.
 * One such phase per run; exact immutable grant, changed source and state CAS.
 * This operator-only API is never exposed to workers or callback handlers. */
async function explicitHumanSourcePhase(c:Client,input:any,row:any,sourceHash:string) {
 const uri=input.explicitHumanPhase;
 if(!uri)return undefined;
 if(row.status!=='failed'||row.state!=='held'||row.role!=='repair')throw Error('Explicit source phase requires the exact failed held repair');
 const rows=(await c.query(`select a.content,a.created_at from artifacts a join action_receipts r
  on r.run_id=a.run_id and r.target=a.uri and r.metadata=a.content and r.receipt_hash is not null
  and r.action_type='operator_source_phase_authorized' and r.agent_id='workflow-orchestrator'
  where a.run_id=$1 and a.uri=$2 and a.kind='explicit_source_phase_authorization'`,[input.runId,uri])).rows;
 const grant=rows.length===1?rows[0].content:null;
 const expiry=Date.parse(grant?.expiresAt),now=Date.now();
 if(!grant||grant.version!==1||grant.authority!=='direct-human'||grant.approvalDecision!=='approved'
  ||grant.operation!=='resume-same-failed-run-after-new-source'||grant.maxAttempts!==1
  ||grant.runId!==input.runId||grant.assignmentId!==input.assignmentId||grant.assignmentFence!==input.expectedFence
  ||grant.projectId!==row.project_key||grant.priorStateVersion!==String(row.state_version)
  ||grant.taskHash!==acceptanceDigest(row.task)
  ||grant.owner!==input.owner||grant.intentFence!==input.intentFence||grant.actor!==input.actor
  ||grant.authorizationReference!==input.authorizationReference||!Number.isFinite(expiry)||expiry<=now
  ||expiry>new Date(rows[0].created_at).getTime()+3600000
  ||!/^human-message:[^\s]+$/u.test(grant.instructionReference??'')||!/^[a-f0-9]{64}$/u.test(grant.instructionSha256??'')
  ||typeof grant.instructionText!=='string'||!grant.instructionText.length||grant.instructionText.length>8192
  ||createHash('sha256').update(grant.instructionText).digest('hex')!==grant.instructionSha256
  ||acceptanceDigest(grant.sourcePaths)!==acceptanceDigest(input.files)||grant.sourceHash!==sourceHash
  ||!Array.isArray(grant.authorizedCommands)||!grant.authorizedCommands.length
  ||new Set(grant.authorizedCommands).size!==grant.authorizedCommands.length
  ||grant.authorizedCommands.some((command:unknown)=>typeof command!=='string'||!row.policy_snapshot?.actions?.allowed_commands?.includes(command))
  ||grant.priorSourceHash!==row.evaluation_metadata?.coordinatorReconciliationContract?.subjectHash
  ||grant.sourceHash===grant.priorSourceHash)throw Error('Fresh exact direct-human source-phase authorization required');
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='existing_assignment_explicit_source_phase_resumed' limit 1",[input.runId])).rowCount)throw Error('One-time explicit source phase already consumed');
 const failure=(await c.query("select created_at from action_receipts where run_id=$1 and action_type='stage_failed' order by created_at desc limit 1",[input.runId])).rows[0];
 if(!failure||new Date(rows[0].created_at).getTime()<=new Date(failure.created_at).getTime())throw Error('Source-phase grant must follow the retained terminal failure');
 return grant;
}

/** Record an operator's reviewed source postimage and actual governed checks.
 * This attests a repair, never independent product acceptance or live effects.
 */
export async function recordVerifiedSourceRepairOnClient(c:Client,input:{runId:string;assignmentId:string;expectedFence:string;owner:string;intentFence:string;files:string[];commandUris:string[];authorizationReference:string;actor:string;historicalSourceReview?:HistoricalSourceReview;explicitHumanPhase?:string}) {
 if(!exactPaths(input.files)||!input.commandUris.length||new Set(input.commandUris).size!==input.commandUris.length||!input.authorizationReference||!input.actor)throw Error('Exact reviewed repair evidence required');
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const row=(await c.query(`select r.status,r.task,r.state_version,r.evaluation_metadata,r.policy_snapshot,r.project_id::text project_key,p.root_uri,q.fence::text,q.state,q.role
  from workflow_runs r join projects p on p.id=r.project_id join queue_coordinator_assignments q on q.child_run_id=r.id
  where r.id=$1 and q.id=$2 and q.fence=$3::bigint and q.project_id=r.project_id for update of r,q`,[input.runId,input.assignmentId,input.expectedFence])).rows[0];
 if(!row||row.status!==(input.explicitHumanPhase?'failed':'blocked')||row.state!=='held')throw Error('Exact terminal assigned run required');
 const intent=(await c.query('select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() for update',[row.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||input.files.some(file=>!intent.file_scopes.includes(file)))throw Error('Repair source must remain under the operator intent');
 const terminalAction=input.explicitHumanPhase?'stage_failed':'stage_blocked';
 const blocked=(await c.query("select receipt_hash,created_at from action_receipts where run_id=$1 and action_type=$2 order by created_at desc limit 1",[input.runId,terminalAction])).rows[0];
 if(!blocked?.receipt_hash)throw Error('Original blocked attempt must be chained');
 const checks=(await c.query(`select a.uri,a.content from artifacts a where a.run_id=$1 and a.uri=any($2::text[]) and a.kind='command_output'
  and a.created_at>$3 and exists(select 1 from action_receipts r where r.run_id=a.run_id and r.action_type='local_command'
   and r.target=a.content->>'commandLine' and r.metadata=a.content and r.receipt_hash is not null)`,[input.runId,input.commandUris,blocked.created_at])).rows;
 if(checks.length!==input.commandUris.length||checks.some(a=>a.content.exitCode!==0||a.content.timedOut!==false)
  ||!checks.some(a=>/\b(?:unittest|pytest)\b|^npm (?:test|run (?:test|check))\b|^node .*--test\b/u.test(a.content.commandLine)))throw Error('Fresh successful governed test evidence required');
 const sourceHash=await sourceSubjectHash(row.root_uri,input.files);
 const phase=await explicitHumanSourcePhase(c,input,row,sourceHash);
 if(phase&&checks.some(a=>a.content.sourceBefore!==sourceHash||a.content.sourceAfter!==sourceHash||a.content.subjectHash!==sourceHash
  ||acceptanceDigest(a.content.sourcePaths)!==acceptanceDigest(input.files)||!phase.authorizedCommands.includes(a.content.commandLine)))throw Error('Explicit source phase requires exact source-bound fresh commands');
 if((await c.query("select 1 from artifacts where run_id=$1 and kind='verified_source_repair' and (content->>'sourceHash'=$2 or content->>'authorizationReference'=$3) limit 1",[input.runId,sourceHash,input.authorizationReference])).rowCount)throw Error('Repair postimage or authorization already recorded');
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 if(!(await verifyRunReceiptChainOnClient(c,input.runId)).valid)throw Error('Repair receipt chain is invalid');
 const historicalSourceObservation=input.historicalSourceReview?await currentHistoricalSourceObservation(c,input.runId,input.files,input.historicalSourceReview):undefined;
 const record={version:1,...input,sourceHash,blockedReceiptHash:blocked.receipt_hash,...(phase?{priorStatus:'failed',sourcePhaseGrantHash:acceptanceDigest(phase)}:{}),checks:checks.map(a=>({uri:a.uri,commandLine:a.content.commandLine,contentHash:acceptanceDigest(a.content)})),...(historicalSourceObservation?{historicalSourceObservation}:{})};
 const uri=`db://workflow_runs/${input.runId}/verified_source_repair/${randomUUID()}`;
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'verified_source_repair',$2,$3::jsonb)",[input.runId,uri,JSON.stringify(record)]);
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'verified_source_repair',target:uri,summary:'Operator attested the repaired source postimage and fresh successful governed checks; no product acceptance granted.',metadata:JSON.stringify(record)});
 return uri;
}

async function currentHistoricalSourceObservation(c:Client,runId:string,files:string[],review:HistoricalSourceReview) {
 // No unfinished effect or live approval can be acknowledged as source history.
 if((await c.query(`select 1 from action_approvals where run_id=$1 and status in ('pending','executing')
  union all select 1 from side_effect_receipts where project_id=$1::text
   or (project_id=(select project_id::text from workflow_runs where id=$1::uuid) and status is distinct from 'completed') limit 1`,[runId])).rowCount)throw Error('Historical source observation cannot reconcile pending or separately reserved effects');
 const receipts=(await c.query("select action_type,target,receipt_hash,metadata from action_receipts where run_id=$1 and action_type in ('file_write','file_delete','file_patch','external_action') order by created_at,receipt_hash limit 1001",[runId])).rows;
 const artifacts=(await c.query("select uri,kind,content from artifacts where run_id=$1 and kind in ('file_write','file_patch','executor_output') order by uri limit 1001",[runId])).rows;
 return observeHistoricalSourceEffects({files,review,receipts,artifacts});
}

async function repairedResumeProof(c:Client,input:ExistingAssignmentRequest,q:any,run:any) {
 const rows=(await c.query(`select a.content from artifacts a join action_receipts r on r.run_id=a.run_id and r.target=a.uri and r.metadata=a.content
  and r.action_type='verified_source_repair' and r.agent_id='workflow-orchestrator' and r.receipt_hash is not null
  where a.run_id=$1 and a.uri=$2 and a.kind='verified_source_repair'`,[input.runId,input.repairProofUri])).rows;
 const proof=rows[0]?.content;
 if(rows.length!==1||proof.runId!==input.runId||proof.assignmentId!==input.assignmentId||proof.expectedFence!==input.expectedFence
  ||proof.owner!==input.owner||proof.intentFence!==input.intentFence||proof.actor!==input.actor||proof.authorizationReference!==input.authorizationReference
  ||!exactPaths(proof.files)||proof.files.some((p:string)=>!input.sourcePaths.includes(p))
  ||await sourceSubjectHash(q.root_uri,proof.files)!==proof.sourceHash)throw Error('Fresh exact repaired-resume proof required');
 const phase=await explicitHumanSourcePhase(c,proof,{...run,project_key:q.project_key,state:q.state,role:q.role},proof.sourceHash);
 if(phase&&acceptanceDigest(phase)!==proof.sourcePhaseGrantHash)throw Error('Source-phase grant changed after attestation');
 if(phase&&(acceptanceDigest(proof.files)!==acceptanceDigest(input.sourcePaths)
  ||acceptanceDigest(phase.authorizedCommands)!==acceptanceDigest(input.commands)))throw Error('Exact source-phase source and command scope required');
 const latest=(await c.query("select receipt_hash from action_receipts where run_id=$1 and action_type=$2 order by created_at desc limit 1",[input.runId,phase?'stage_failed':'stage_blocked'])).rows[0];
 if(latest?.receipt_hash!==proof.blockedReceiptHash||q.prior_child!==input.runId||q.state!=='held'||run.status!==(phase?'failed':'blocked')
  ||!run.evaluation_metadata?.existingAssignmentReconciliationUri)throw Error('Repair must bind the same latest blocked continuation');
 if(!phase&&(await c.query("select count(*)::int n from action_receipts where run_id=$1 and action_type='existing_assignment_repaired_resumed'",[input.runId])).rows[0].n>=3
  ||(await c.query("select 1 from action_receipts where run_id=$1 and action_type='existing_assignment_repaired_resumed' and target=$2 limit 1",[input.runId,input.repairProofUri])).rowCount)throw Error('Repaired-resume proof consumed or finite budget exhausted');
 const checks=(await c.query('select uri,content from artifacts where run_id=$1 and uri=any($2::text[])',[input.runId,proof.checks.map((a:any)=>a.uri)])).rows;
 if(checks.length!==proof.checks.length||checks.some(a=>acceptanceDigest(a.content)!==proof.checks.find((p:any)=>p.uri===a.uri)?.contentHash))throw Error('Verified repair command evidence changed');
 return proof;
}

export async function previewExistingAssignmentOnClient(c:Client,input:ExistingAssignmentRequest) {
 if(!input.assignmentId||!input.runId||!input.expectedFence||!input.owner||!input.intentFence
  ||!input.actor||!input.reason||!input.authorizationReference||!exactPaths(input.sourcePaths)
  ||!input.commands.length||new Set(input.commands).size!==input.commands.length)throw Error('Exact operator scope and authorization reference required');
 const q=(await c.query(`select q.*,q.id::text claim_id,q.fence::text claim_fence,q.project_id::text project_key,
  q.source_run_id::text source_id,q.child_run_id::text prior_child,p.root_uri,
  exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
  from queue_coordinator_assignments q join projects p on p.id=q.project_id where q.id=$1 for update of q,p`,[input.assignmentId])).rows[0];
 if(!q||q.claim_fence!==input.expectedFence||!['held','uncertain','running'].includes(q.state)||!q.canonical
  ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(q.root_uri)||await fs.realpath(q.root_uri)!==q.root_uri)throw Error('Exact canonical held assignment required');
 const rows=(await c.query('select *,id::text run_key,project_id::text project_key from workflow_runs where id=any($1::uuid[]) for update',[[q.source_id,input.runId,q.prior_child].filter(Boolean)])).rows;
 const source=rows.find(r=>r.run_key===q.source_id),run=rows.find(r=>r.run_key===input.runId),prior=rows.find(r=>r.run_key===q.prior_child),m=run?.evaluation_metadata??{};
 const branch=input.cancelledBranch;
 if([branch,input.repairProofUri,input.executionRecipe,input.verifierReassessment].filter(Boolean).length>1)throw Error('Reconciliation modes are separate operations');
 if(!source||!run||run.project_key!==q.project_key||!((input.executionRecipe||input.verifierReassessment)?run.status==='failed':input.repairProofUri?['blocked','failed'].includes(run.status):['queued','running'].includes(run.status))||run.lease_owner
  ||(run.lease_expires_at&&new Date(run.lease_expires_at).getTime()>Date.now())
  ||m.queueCoordinatorClaimId!==input.assignmentId||String(m.queueCoordinatorFence)!==(branch?.predecessorFence??input.expectedFence)
  ||m.sourceRunId!==q.source_id||q.family_id!==`${q.project_key}:${source.run_set_id}`)throw Error('Run does not belong to the exact existing assignment');
 let branchPredecessor:any;
 let branchTasks:any[]=[];
 if(branch){
  if(q.state!=='held'||!/^[1-9][0-9]*$/u.test(branch.predecessorFence)||BigInt(branch.predecessorFence)>=BigInt(input.expectedFence)
   ||branch.predecessorRunId===q.prior_child||m.replayOfRunId!==branch.predecessorRunId||run.status!=='queued')throw Error('Exact older cancelled predecessor branch required');
  branchPredecessor=(await c.query('select *,id::text run_key,project_id::text project_key from workflow_runs where id=$1 for update',[branch.predecessorRunId])).rows[0];
  for(const [candidate,fence]of [[branchPredecessor,branch.predecessorFence],[prior,input.expectedFence]] as const){
   if(!candidate||candidate.status!=='cancelled'||candidate.project_key!==q.project_key||candidate.run_set_id!==source.run_set_id
    ||candidate.evaluation_metadata?.queueCoordinatorClaimId!==input.assignmentId
    ||String(candidate.evaluation_metadata?.queueCoordinatorFence)!==fence
    ||candidate.evaluation_metadata?.sourceRunId!==q.source_id||candidate.lease_owner
    ||candidate.lease_expires_at&&new Date(candidate.lease_expires_at).getTime()>Date.now())throw Error('Retained cancelled branch identity or lifetime is unavailable');
  }
  const branchIds=[branch.predecessorRunId,q.prior_child];
  branchTasks=(await c.query('select * from workflow_tasks where run_id=any($1::uuid[]) order by id limit 1001 for update',[branchIds])).rows;
  if(branchTasks.length>1000||branchTasks.some(t=>['queued','leased','running'].includes(t.status)||t.lease_expires_at&&new Date(t.lease_expires_at).getTime()>Date.now()))throw Error('Cancelled branch retains active task authority or exceeds review bounds');
  if((await c.query(`select 1 from action_approvals where run_id=any($1::uuid[]) and status in ('pending','executing')
   union all select 1 from action_receipts where run_id=any($1::uuid[]) and action_type in ('file_write','file_delete','file_patch','external_action')
   union all select 1 from artifacts where run_id=any($1::uuid[]) and kind in ('file_write','file_patch','executor_output') limit 1`,[branchIds])).rowCount)throw Error('Cancelled branch effects require separate reconciliation');
  const commands=(await c.query("select target,metadata from action_receipts where run_id=any($1::uuid[]) and action_type='local_command' limit 1001",[branchIds])).rows;
  if(commands.length>1000||commands.some(a=>!input.commands.includes(a.target)||a.metadata?.exitCode!==0||a.metadata?.timedOut!==false))throw Error('Unresolved cancelled branch command evidence');
 }else if(q.prior_child!==input.runId&&(!prior||!['completed','blocked','failed','cancelled'].includes(prior.status)
  ||m.replayOfRunId!==q.prior_child))throw Error('Only the exact retained terminal predecessor can be rebound');
 const repairProof=input.repairProofUri?await repairedResumeProof(c,input,q,run):undefined;
 const recipeProof=await inspectExecutionRecipeAdoption(c,input,q,run);
 const verifierProof=await inspectVerifierReassessment(c,input,q,run);
 const resumedStatus=recipeProof||verifierProof||repairProof?.explicitHumanPhase?'failed':'blocked';
 const resuming=!!(repairProof||recipeProof||verifierProof);
 const tasks=(await c.query('select * from workflow_tasks where run_id=$1 order by id for update',[input.runId])).rows;
 if(!tasks.length||tasks.some(t=>!(verifierProof?['failed','cancelled'].includes(t.status):resuming?[resumedStatus,'queued'].includes(t.status):t.status==='queued')
  ||t.worker_id&&!(resuming&&t.status===resumedStatus)||t.lease_expires_at&&new Date(t.lease_expires_at).getTime()>Date.now())
  ||resuming&&!tasks.some(t=>t.status===resumedStatus))throw Error('All remaining stages must be safely unleased and match the explicit resume mode');
 // Never reclaim a live owner, even when the recorded task lease is absent.
 if((await c.query('select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp()',
  [q.project_key,q.owner,q.intent_fence])).rowCount)throw Error('Prior assignment intent is still live');
 const intent=(await c.query('select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() for update',
  [q.project_key,input.owner,input.intentFence])).rows[0];
 if(!intent||acceptanceDigest([...intent.file_scopes].sort())!==acceptanceDigest([...input.sourcePaths].sort()))throw Error('Fresh exact work intent required');
 const actions=run.policy_snapshot?.actions;
 if(!actions||input.commands.some(command=>!actions.allowed_commands?.includes(command)))throw Error('Reconciliation cannot widen the frozen command policy');
 // Existing execution is preserved, never reset. A live/uncertain action or any
 // prior file mutation needs effect-specific reconciliation, not this API.
 const hasPriorEffects=(await c.query(`select 1 from action_approvals where run_id=$1 and status in ('pending','executing')
  union all select 1 from action_receipts where run_id=$1 and action_type in ('file_write','file_delete','file_patch','external_action')
  union all select 1 from artifacts where run_id=$1 and kind in ('file_write','file_patch','executor_output') limit 1`,[input.runId])).rowCount;
 if(hasPriorEffects&&!verifierProof){
  if(!repairProof?.historicalSourceReview||!repairProof.historicalSourceObservation)throw Error('Pending authority or prior effects require separate reconciliation');
  const observed=await currentHistoricalSourceObservation(c,input.runId,repairProof.files,repairProof.historicalSourceReview);
  if(acceptanceDigest(observed)!==acceptanceDigest(repairProof.historicalSourceObservation))throw Error('Historical source evidence changed after operator observation');
 }
 const others=(await c.query("select id::text,project_id::text project_key,role,lane,file_scopes from queue_coordinator_assignments where id<>$1 and state in ('reserved','running','uncertain') for update",[input.assignmentId])).rows;
 const lane=input.lane??q.lane;
 if(recipeProof){const {queueWorkingOccupancyOnClient}=await import('./queue-coordinator.js');if((await queueWorkingOccupancyOnClient(c)).count>=5)throw Error('Working capacity is full');}
 if(input.lane!==undefined){
  if(q.state!=='held'||q.role!=='repair'||!Number.isInteger(lane)||lane<1||lane>5)throw Error('Explicit vacant repair lane requires a held repair assignment');
  const {queueWorkingOccupancyOnClient}=await import('./queue-coordinator.js');
  if((await queueWorkingOccupancyOnClient(c)).count>=5)throw Error('Working capacity is full; preserve existing assignments');
 }
 if(others.some(other=>other.role===q.role&&other.lane===lane))throw Error('Exact coordinator lane is occupied; preserve its existing owner');
 if(others.some(other=>other.project_key===q.project_key&&(!Array.isArray(other.file_scopes)||!other.file_scopes.length
  ||other.file_scopes.some((a:unknown)=>typeof a!=='string'||input.sourcePaths.some(b=>a===b||a.startsWith(`${b}/`)||b.startsWith(`${a}/`))))))throw Error('Another unresolved assignment retains overlapping ownership');
 if((await c.query(`select 1 from queue_coordinator_assignments where id<>$1 and family_id=$2 and state in ('reserved','running','uncertain')
  union all select 1 from workflow_runs where id<>$3 and id<>$4 and evaluation_metadata->>'queueCoordinatorClaimId'=$1::text
   and status in ('queued','leased','running') limit 1`,[input.assignmentId,q.family_id,input.runId,q.prior_child])).rowCount)throw Error('Another family continuation is active');
 const original=source.evaluation_metadata?.acceptanceContract;
 const oldContract=resuming?await reconciledExecutionContract(c,input.runId,m):m.acceptanceContract;
 const retains=(paths:string[])=>resuming?paths.every(p=>input.sourcePaths.includes(p)):acceptanceDigest([...paths].sort())===acceptanceDigest([...input.sourcePaths].sort());
 if(original?.sourcePaths&&!retains(original.sourcePaths))throw Error('Original requirement scope must be retained');
 if(oldContract?.sourcePaths&&!retains(oldContract.sourcePaths))throw Error('Existing requirement scope must be retained');
 const deliverables=(oldContract??original)?.deliverables??[{id:'original-requirements',description:source.task,requiredGates:['implementation','verification','packaging','supervision']}];
 const contract:StructuredAcceptanceContract={version:1,contractId:`${resuming?'existing-assignment-repaired':'existing-assignment'}:${input.runId}:${input.expectedFence}`,projectId:q.project_key,originRunId:input.runId,
  taskHash:acceptanceDigest(run.task),sourcePaths:input.sourcePaths,subjectHash:await sourceSubjectHash(q.root_uri,input.sourcePaths),
  deliverables:deliverables.map((d:any)=>({...d,status:'pending',receipts:{},gaps:[]}))};
 if(verifierProof&&contract.subjectHash!==verifierProof.sourceHash)throw Error('Verifier source changed during reconciliation');
 const priorContinuations=resuming?(await c.query("select uri,content,task_id::text from artifacts where run_id=$1 and kind='stage_continuation' order by uri limit 1001",[input.runId])).rows:[];
 if(priorContinuations.length>1000||Buffer.byteLength(JSON.stringify(priorContinuations),'utf8')>16_000_000)throw Error('Blocked continuation history exceeds preservation bound');
 const snapshot={input,q,run,source,prior,tasks,contract,lane,priorContinuations,...(branch?{branchPredecessor,branchTasks}:{}),...(repairProof?{repairProof}: {}),...(recipeProof?{recipeProof}: {})};
 return {snapshot:{...snapshot,...(verifierProof?{verifierProof}:{})},digest:acceptanceDigest({...snapshot,...(verifierProof?{verifierProof}:{})})};
}

/** Fresh operator contract is supplemental. Never replace historical contracts,
 * task text, attempts, completed stages, statuses or predecessor records.
 * Current execution is narrowed to read-only project actions.
 */
export async function reconcileExistingAssignmentOnClient(c:Client,input:ExistingAssignmentRequest,expectedDigest:string) {
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const preview=await previewExistingAssignmentOnClient(c,input);
 if(preview.digest!==expectedDigest)throw Error('Assignment changed after reviewed preview');
 const {q,run,contract}=preview.snapshot;
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 for(const id of new Set([q.source_id,input.runId,q.prior_child,input.cancelledBranch?.predecessorRunId].filter(Boolean)))if(!(await verifyRunReceiptChainOnClient(c,id!)).valid)throw Error('Original and continuation receipt chains must verify');
 if(!input.repairProofUri&&!input.executionRecipe&&!input.verifierReassessment&&(await c.query("select 1 from action_receipts where run_id=$1 and action_type='existing_assignment_reconciled' limit 1",[input.runId])).rowCount)throw Error('Existing continuation was already reconciled');
 const fresh=(await c.query(`update queue_coordinator_assignments set owner=$2,intent_fence=$3,file_scopes=$4::jsonb,
  child_run_id=$5,lane=$7,fence=nextval(pg_get_serial_sequence('queue_coordinator_assignments','fence')),state='running',
  reason='Explicit existing-run reconciliation; history and requirements preserved',updated_at=clock_timestamp()
  where id=$1 and fence=$6::bigint returning fence::text`,[input.assignmentId,input.owner,input.intentFence,JSON.stringify(input.sourcePaths),input.runId,input.expectedFence,preview.snapshot.lane])).rows[0];
 if(!fresh)throw Error('Assignment fence changed');
 const id=randomUUID(),uri=`db://workflow_runs/${input.runId}/existing_assignment_reconciled/${id}`;
 const record={version:1,id,authorizationReference:input.authorizationReference,actor:input.actor,reason:input.reason,
  priorAssignment:q,priorMetadata:run.evaluation_metadata,priorPolicy:run.policy_snapshot,priorRun:run,priorTasks:preview.snapshot.tasks,priorContinuations:preview.snapshot.priorContinuations,
  ...(input.cancelledBranch?{cancelledBranch:input.cancelledBranch,branchPredecessor:preview.snapshot.branchPredecessor,branchTasks:preview.snapshot.branchTasks}:{}),repairProofUri:input.repairProofUri??null,executionRecipe:preview.snapshot.recipeProof??null,contract,
  verifierReassessment:preview.snapshot.verifierProof??null,
  assignmentId:input.assignmentId,runId:input.runId,owner:input.owner,intentFence:input.intentFence,fence:fresh.fence,lane:preview.snapshot.lane,previewDigest:preview.digest};
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'existing_assignment_reconciled',$2,$3::jsonb)",[input.runId,uri,JSON.stringify(record)]);
 const metadata={...run.evaluation_metadata,queueCoordinatorFence:fresh.fence,workIntent:{owner:input.owner,fencingToken:input.intentFence},
  existingAssignmentReconciliationUri:uri,coordinatorReconciliationContract:contract,...((input.repairProofUri||input.executionRecipe||input.verifierReassessment)?{noAutomaticRepeat:true}:{})};
 const policy={...run.policy_snapshot,actions:{...run.policy_snapshot.actions,allowed_commands:input.commands,allowed_write_paths:[],isolate_command_writes:true,...(input.executionRecipe?{scoped_native_pty_commands:input.executionRecipe.commands}:preview.snapshot.verifierProof?{scoped_native_pty_commands:preview.snapshot.verifierProof.ptyCommands}:{})}};
 await c.query('update workflow_runs set evaluation_metadata=$2::jsonb,policy_snapshot=$3::jsonb where id=$1',[input.runId,JSON.stringify(metadata),JSON.stringify(policy)]);
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'existing_assignment_reconciled',target:uri,
  summary:'Rebound existing continuation with fresh contract and fences; all historical records retained; read-only actions only.',metadata:JSON.stringify(record)});
 if(input.repairProofUri||input.executionRecipe||input.verifierReassessment){
  const explicitPhase=Boolean(preview.snapshot.repairProof?.explicitHumanPhase);
  const fromStatus=input.executionRecipe||explicitPhase||input.verifierReassessment?'failed':'blocked';
  const actionType=input.verifierReassessment?'existing_assignment_verifier_reassessed':input.executionRecipe?'existing_assignment_recipe_resumed':explicitPhase?'existing_assignment_explicit_source_phase_resumed':'existing_assignment_repaired_resumed';
  const proofTarget=input.verifierReassessment?.authorizationUri??input.repairProofUri??input.executionRecipe!.failedCommandUri;
  // A separate explicit operator action, never a generic terminal transition.
  // The full prior terminal attempt is sealed before current execution is rearmed.
  const updated=(await c.query(`update workflow_runs set status='queued',state_version=state_version+1,finished_at=null
   where id=$1 and status=$3 and state_version=$2::bigint returning state_version::text,lease_epoch::text`,[input.runId,run.state_version,fromStatus])).rows[0];
  if(!updated)throw Error('Terminal attempt changed before explicit resume');
  await c.query("update workflow_tasks set status='queued',started_at=null,finished_at=null,worker_id=null,lease_expires_at=null,available_at=clock_timestamp() where run_id=$1 and status=any($2::text[])",[input.runId,input.verifierReassessment?['failed','cancelled']:[fromStatus]]);
  await c.query(`insert into workflow_run_transitions(run_id,from_status,to_status,state_version,lease_epoch,actor,reason,idempotency_key,metadata)
   values($1,$8,'queued',$2::bigint,$3::bigint,$4,$5,$6,$7::jsonb)`,[input.runId,updated.state_version,updated.lease_epoch,input.actor,input.reason,`operator-repaired-resume:${acceptanceDigest(proofTarget)}`,JSON.stringify({repairProofUri:input.repairProofUri,priorBlockedAttemptUri:uri,assignmentFence:fresh.fence}),fromStatus]);
  await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType,target:proofTarget,
   summary:input.verifierReassessment?'Explicit one-time current-revision verifier reassessment; failed attempt, task attempts, candidate and all four gates retained; no acceptance granted.':input.executionRecipe?'Explicit one-time same-run recipe adoption; failed attempt retained, no acceptance granted.':'Explicitly resumed the same blocked run after verified source repair; blocked attempt and all original requirements retained.',metadata:JSON.stringify({authorizationReference:input.authorizationReference,priorBlockedAttemptUri:uri,stateVersion:updated.state_version,assignmentFence:fresh.fence})});
  await enqueueRunNotification(c,{runId:input.runId,kind:'progress',eventKey:`transition:${updated.state_version}`,title:input.verifierReassessment?'Verifier reassessment authorized':input.executionRecipe?'Run resumed after prospective recipe adoption':'Run resumed after verified source repair',
   body:JSON.stringify({version:1,type:'run.state_changed',id:`${input.runId}:transition:${updated.state_version}`,runId:input.runId,sequence:updated.state_version,
    occurredAt:new Date().toISOString(),previousState:fromStatus,state:'queued',summary:input.verifierReassessment?'Explicit one-time verifier reassessment; candidate, failed attempt and four gates retained.':input.executionRecipe?'Explicit one-time recipe adoption; failed attempt and original requirements retained.':'Explicit repaired resume of the same run; blocked attempt and original requirements retained.',result:null})});
 }
 await prepareReconciledAssignmentContextOnClient(c,input.runId,fresh.fence);
 return {runId:input.runId,assignmentId:input.assignmentId,owner:input.owner,fence:fresh.fence,intentFence:input.intentFence,artifactUri:uri};
}

export async function reconcileExistingAssignment(input:ExistingAssignmentRequest,expectedDigest:string) {
 return withClient(async c=>{await c.query('begin');try{const result=await reconcileExistingAssignmentOnClient(c,input,expectedDigest);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}});
}

/** Correct only the proven pre-start historical lease-key collision. Never
 * recover a provider/effect-bearing task or another owner's work. Fresh epoch
 * invalidates the exited worker; attempt count and prior claim are retained.
 */
export async function requeueOwnedPrestartLeaseOnClient(c:Client,input:{runId:string;taskId:string;assignmentId:string;assignmentFence:string;owner:string;intentFence:string;leaseEpoch:string;authorizationReference:string}) {
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const worker=`${input.owner}:${input.assignmentFence}`;
 const row=(await c.query(`select r.*,t.id::text task_id,t.status task_status,t.attempts,t.started_at task_started,t.lease_generation::text task_epoch,t.worker_id,t.lease_expires_at task_expiry
  from workflow_runs r join workflow_tasks t on t.run_id=r.id join queue_coordinator_assignments q on q.child_run_id=r.id
  join work_intents i on i.project_id=q.project_id::text and i.owner=q.owner and i.fencing_token::text=q.intent_fence and i.expires_at>clock_timestamp()
  where r.id=$1 and t.id=$2 and q.id=$3 and q.fence=$4::bigint and q.owner=$5 and q.intent_fence=$6 and q.state='running'
   and q.project_id=r.project_id and r.lease_owner=$7 and r.lease_epoch=$8::bigint for update of r,t,q`,
  [input.runId,input.taskId,input.assignmentId,input.assignmentFence,input.owner,input.intentFence,worker,input.leaseEpoch])).rows[0];
 const ownedLeased=row?.task_status==='leased'&&row.worker_id===worker;
 const recoveredQueued=row?.task_status==='queued'&&row.worker_id===null&&row.task_expiry===null;
 if(!input.authorizationReference||!row||row.status!=='queued'||(!ownedLeased&&!recoveredQueued)||row.task_started!==null||row.task_epoch!==input.leaseEpoch
  ||row.evaluation_metadata?.queueCoordinatorClaimId!==input.assignmentId||row.evaluation_metadata?.queueCoordinatorFence!==input.assignmentFence
  ||!row.evaluation_metadata?.coordinatorReconciliationContract?.contractId?.startsWith('existing-assignment-repaired:'))throw Error('Exact owned repaired pre-start claim required');
 if(!(await c.query("select 1 from workflow_run_transitions where run_id=$1 and idempotency_key=$2 and to_status='leased' and state_version<$3::bigint",[input.runId,`run-leased:${input.taskId}`,row.state_version])).rowCount)throw Error('Historical pre-start lease-key collision not proven');
 const claim=(await c.query("select created_at from action_receipts where run_id=$1 and action_type='stage_leased' and target=$2 and metadata->>'leaseEpoch'=$3 order by created_at desc limit 1",[input.runId,input.taskId,input.leaseEpoch])).rows[0];
 if(recoveredQueued&&(!claim||!(await c.query("select 1 from action_receipts where run_id=$1 and target=$2 and action_type='stage_requeued' and metadata->>'cause'='expired_worker_lease' and created_at>$3 limit 1",[input.runId,input.taskId,claim.created_at])).rowCount))throw Error('Exact pre-start expiry recovery receipt required');
 if(!claim||(await c.query(`select 1 from action_receipts where run_id=$1 and created_at>$2 and action_type in
  ('stage_started','model_route','model_route_failed','execution_progress','local_command','file_write','external_action')
  union all select 1 from artifacts where run_id=$1 and created_at>$2 and kind in ('model_route','command_output','executor_output','file_write')
  union all select 1 from action_approvals where run_id=$1 and status in ('pending','executing') limit 1`,[input.runId,claim.created_at])).rowCount)throw Error('Pre-start no-effect boundary is unproven');
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='existing_assignment_prestart_requeued' and metadata->>'priorLeaseEpoch'=$2 limit 1",[input.runId,input.leaseEpoch])).rowCount)throw Error('Pre-start correction already consumed');
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 if(!(await verifyRunReceiptChainOnClient(c,input.runId)).valid)throw Error('Pre-start claim receipt chain invalid');
 const next=(await c.query("update workflow_runs set lease_epoch=lease_epoch+1,lease_owner=null,lease_expires_at=null where id=$1 and lease_epoch=$2::bigint returning lease_epoch::text",[input.runId,input.leaseEpoch])).rows[0];
 await c.query("update workflow_tasks set status='queued',worker_id=null,lease_expires_at=null,lease_generation=$2::bigint,available_at=clock_timestamp() where id=$1 and status in ('leased','queued')",[input.taskId,next.lease_epoch]);
 const uri=`db://workflow_runs/${input.runId}/prestart_lease_requeued/${randomUUID()}`;
 const record={version:1,...input,priorClaim:row,priorLeaseEpoch:input.leaseEpoch,nextLeaseEpoch:next.lease_epoch,noEffectsProven:true};
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'existing_assignment_prestart_requeued',$2,$3::jsonb)",[input.runId,uri,JSON.stringify(record)]);
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'existing_assignment_prestart_requeued',target:uri,
  summary:'Corrected proven pre-start lease-key collision with fresh epoch; same task and historical attempts retained.',metadata:JSON.stringify(record)});
 return {runId:input.runId,taskId:input.taskId,leaseEpoch:next.lease_epoch,artifactUri:uri};
}

/** Resolve only the exact append-only operator attestation, never a model field. */
export async function reconciledExecutionContract(c:Pick<Client,'query'>,runId:string,metadata:Record<string,any>):Promise<StructuredAcceptanceContract|undefined> {
 if(!metadata.existingAssignmentReconciliationUri&&!metadata.coordinatorReconciliationContract)return undefined;
 const rows=(await c.query(`select a.content from artifacts a join action_receipts r on r.run_id=a.run_id and r.target=a.uri
  and r.action_type='existing_assignment_reconciled' and r.agent_id='workflow-orchestrator' and r.metadata=a.content
  and r.receipt_hash is not null where a.run_id=$1 and a.uri=$2 and a.kind='existing_assignment_reconciled'`,[runId,metadata.existingAssignmentReconciliationUri])).rows;
 const record=rows[0]?.content;
 if(rows.length!==1||record.runId!==runId||record.assignmentId!==metadata.queueCoordinatorClaimId||record.fence!==metadata.queueCoordinatorFence
  ||acceptanceDigest(record.contract)!==acceptanceDigest(metadata.coordinatorReconciliationContract))throw Error('Reconciled execution contract attestation is unavailable');
 return record.contract;
}

/** Refresh the brief without replacing task text or any historical artifact. */
export async function prepareReconciledAssignmentContextOnClient(c:Client,runId:string,fence:string) {
 const row=(await c.query(`select r.evaluation_metadata metadata,q.file_scopes,q.owner,q.intent_fence,r.policy_snapshot
  from workflow_runs r join queue_coordinator_assignments q on q.child_run_id=r.id
  join work_intents i on i.project_id=q.project_id::text and i.owner=q.owner and i.fencing_token::text=q.intent_fence and i.expires_at>clock_timestamp()
  where r.id=$1 and q.fence=$2::bigint and q.state='running' and r.lease_owner is null for update of r,q`,[runId,fence])).rows[0];
 if(!row)throw Error('Exact fresh assignment required for context refresh');
 const contract=await reconciledExecutionContract(c,runId,row.metadata);
 if(!contract)throw Error('Attested current execution contract required');
 const repair=row.metadata.existingAssignmentReconciliationUri?(await c.query("select content->>'repairProofUri' repair from artifacts where run_id=$1 and uri=$2",[runId,row.metadata.existingAssignmentReconciliationUri])).rows[0]?.repair:null;
 const repairEvidence=repair?(await c.query("select content from artifacts where run_id=$1 and uri=$2 and kind='verified_source_repair'",[runId,repair])).rows[0]?.content:null;
 const text=`Current operator reconciliation (original task and all history retained):\nThis is the same existing run, not a new repair workflow. Use the fresh attested acceptance contract and current source. Old source excerpts, command policies and work-intent owners in the task or prior continuations are historical evidence only. Read current .agent-workflow/context.md and its latest receipt before diagnosing an already-repaired gap. Do not infer implementation absence from historical excerpts.\n${repair?`Verified source repair evidence: ${repair}. Read its current source paths and governed checks before restating a prior source gap; repaired refusal is not native product acceptance.\n`:''}Current owner: ${row.owner}; work-intent fence: ${row.intent_fence}; assignment fence: ${fence}. Root renews/releases; do not acquire a second intent.\nProject file writes, deployment, restart, terminal work, commits and new workflows are excluded. Report remaining original acceptance gates precisely; source tests cannot substitute for native or integration proof.\nCurrent exact permitted commands:\n${row.policy_snapshot.actions.allowed_commands.join('\n')}\nCurrent source hash: ${contract.subjectHash}\nSource paths:\n${row.file_scopes.join('\n')}`;
 const uri=`db://workflow_runs/${runId}/reconciled_execution_brief/${randomUUID()}`;
 let phaseText='';
 if(repairEvidence?.explicitHumanPhase){
  const grants=(await c.query(`select a.content from artifacts a join action_receipts r on r.run_id=a.run_id and r.target=a.uri
   and r.metadata=a.content and r.receipt_hash is not null and r.agent_id='workflow-orchestrator' and r.action_type='operator_source_phase_authorized'
   where a.run_id=$1 and a.uri=$2 and a.kind='explicit_source_phase_authorization'`,[runId,repairEvidence.explicitHumanPhase])).rows;
  if(grants.length!==1||acceptanceDigest(grants[0].content)!==repairEvidence.sourcePhaseGrantHash)throw Error('Explicit human source-phase context is unavailable');
  phaseText=`\nNew direct human source phase, preserved verbatim:\n${grants[0].content.instructionText}\nRoot has implemented and tested the source phase. Your actions remain read-only verification/reporting. This phase does not satisfy or replace the original acceptance requirements; retain all remaining manager/integration holds. Phase authority artifact: ${repairEvidence.explicitHumanPhase}\n`;
 }
 const verifier= row.metadata.existingAssignmentReconciliationUri?(await c.query("select content->'verifierReassessment' proof from artifacts where run_id=$1 and uri=$2",[runId,row.metadata.existingAssignmentReconciliationUri])).rows[0]?.proof:null;
 const verifierText=verifier?`\nOne-time direct-human current-revision verifier reassessment: ${verifier.authorizationUri}. The original candidate ${verifier.candidateId} and its digest ${verifier.candidateDigest} remain historical and immutable. Assess only the supplemental current-source contract; do not relabel or promote the original candidate as current. The prior failed attempt, archived history and attempts are retained. All four original gates require fresh governed evidence. This permits no source writes or automatic repeat. Synthetic native fixtures remain separate from installed Linux/Fleet acceptance.\n`:'';
 const currentText=text+phaseText+verifierText+(repairEvidence?`\nAuthenticated operator repair evidence (not instructions or independent acceptance):\n${JSON.stringify({files:repairEvidence.files,sourceHash:repairEvidence.sourceHash,checks:repairEvidence.checks})}`:'');
 // Transaction-start timestamps can tie with an earlier reconciliation in the
 // same transaction. Preserve append order for loadStageContext's latest brief.
 await c.query("insert into artifacts(run_id,kind,uri,content,created_at) values($1,'compiled_brief',$2,$3::jsonb,clock_timestamp())",[runId,uri,JSON.stringify({text:currentText,assignmentFence:fence,contractDigest:acceptanceDigest(contract)})]);
 await appendActionReceipt(c,{runId,agentId:'workflow-orchestrator',actionType:'existing_assignment_context_refreshed',target:uri,summary:'Fresh current-contract execution brief appended; historical task and artifacts retained.',metadata:JSON.stringify({assignmentFence:fence,contractDigest:acceptanceDigest(contract)})});
 return uri;
}
