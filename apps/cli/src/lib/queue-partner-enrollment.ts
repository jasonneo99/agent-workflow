import fs from 'node:fs/promises';
import type {Client} from 'pg';
import {withClient} from '../../../../packages/storage/src/client.js';
import {acceptanceDigest,acceptancePreflight} from '../../../../packages/storage/src/acceptance.js';
import {appendActionReceipt} from '../../../../packages/storage/src/receipt-writer.js';
import {advanceCrossProjectEnrollment,validateCrossProjectEnrollment,type CrossProjectEnrollment,type DependencyScope} from '../../../../packages/storage/src/cross-project-enrollment.js';
import {acquireWorkIntent,releaseWorkIntent,verifyRunReceiptChainOnClient,createWorkflowRun,seedRegistry} from '../../../../packages/storage/src/postgres.js';
import {assertPartnerPlanningOpen} from './queue-partner-watch.js';
import {loadProjectConfig,loadWorkflows} from '../../../../packages/agent-registry/src/loaders.js';
import {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {canonicalJsonHash,resolveExecutionPolicy} from '../../../../packages/policy-engine/src/index.js';
import {assertFilePathAllowed} from '../../../../packages/local-tools/src/file-writer.js';
import {sourceSubjectHash} from '../../../../packages/workflow-engine/src/source-subject.js';
import {inheritedCodexOrigin} from '../codex-callback.js';
import {verifyRepairedRevisionAttestationOnClient} from '../../../../packages/storage/src/repaired-revision.js';
import {recordQueuePartnerDecision} from '../../../../packages/storage/src/queue-partner-decisions.js';
import {enrollmentResumeOpen} from '../../../../packages/storage/src/partner-enrollment-resume.js';
import {legacyOfflineCommands} from './queue-legacy-offline-commands.js';
import {queueWorkingOccupancyOnClient} from '../../../../packages/storage/src/queue-coordinator.js';

export async function partnerEnrollmentWindow(c:Client,p:CrossProjectEnrollment,now=Date.now()){
  const originalOpen=now<Date.parse(p.startBefore)&&now<Date.parse(p.pauseAt);
  const rows=(await c.query(`select metadata from action_receipts where run_id=$1
    and agent_id='workflow-orchestrator' and action_type='operator_cross_project_enrollment_resumed'
    and metadata->>'planId'=$2 order by created_at desc limit 1`,[p.sourceRunId,p.id])).rows;
  // Newest record dominates: never resurrect an earlier resume after revocation/expiry.
  const revoked=(await c.query(`select 1 from action_receipts where run_id=$1
    and action_type='operator_cross_project_enrollment_resume_revoked' and metadata->>'planId'=$2
    and created_at >= coalesce((select max(created_at) from action_receipts where run_id=$1
      and action_type='operator_cross_project_enrollment_resumed' and metadata->>'planId'=$2),'-infinity'::timestamptz) limit 1`,[p.sourceRunId,p.id])).rowCount;
  if(revoked)return false;
  return originalOpen||Boolean(rows[0]&&enrollmentResumeOpen(p,rows[0].metadata,now));
}

async function tx<T>(c:Client,fn:()=>Promise<T>){await c.query('begin');try{const v=await fn();await c.query('commit');return v;}catch(e){await c.query('rollback');throw e;}}
const uri=(p:CrossProjectEnrollment,s:DependencyScope)=>`db://workflow_runs/${p.sourceRunId}/cross_project_enrollment_attempt/${p.id}/${s.id}`;
/** Every provider command remains independently subject to the target project's policy. */
export function enrollmentOfflineCommands(config:ReturnType<typeof projectConfigSchema.parse>,sourcePaths:readonly string[]=[]):string[]{
  // A broad test grant does not establish that unrelated tests are offline or
  // inside this independently approved dependency scope. This narrows execution
  // recipes only; every original acceptance gate remains mandatory.
  return legacyOfflineCommands(config,sourcePaths);
}

export async function dependencyEnrollmentPreflight(c:Client,s:DependencyScope,load=loadProjectConfig){
  const project=(await c.query(`select p.root_uri,exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical from projects p where p.id=$1`,[s.projectId])).rows[0];
  if(!project?.canonical||project.root_uri!==s.projectRootUri||await fs.realpath(s.projectRootUri)!==s.projectRootUri)return {ok:false,reason:'Exact canonical project registration unavailable'};
  const resolved=resolveExecutionPolicy(await load(s.projectRootUri),'local');
  if(canonicalJsonHash(resolved.project)!==s.policyHash)return {ok:false,reason:'Target project policy changed; Partner must revalidate exact enrollment evidence'};
  for(const path of s.sourcePaths)assertFilePathAllowed(path,resolved.project);
  if(!enrollmentOfflineCommands(resolved.project,s.sourcePaths).length)return {ok:false,reason:'Target project offline verification commands unavailable'};
  const busy=(await c.query(`select 1 from workflow_runs where project_id=$1 and status in ('queued','leased','running')
    union all select 1 from action_approvals a join workflow_runs r on r.id=a.run_id where r.project_id=$1 and a.status in ('pending','executing')
    union all select 1 from queue_coordinator_assignments where project_id=$1 and state in ('reserved','running','uncertain') limit 1`,[s.projectId])).rowCount;
  const occupied=await queueWorkingOccupancyOnClient(c);
  const capacity=occupied.count<5&&!occupied.verifier&&!occupied.dependencies;
  return {ok:!busy&&capacity,reason:busy?'Active project work, uncertain ownership or approvals; keep dependency held':!capacity?'Repair capacity or independent verifier occupied; keep dependency held':'Exact project policy and idle execution scope verified'};
}

/** One bounded repair of enrollment bookkeeping, not a failed-run replay loop.
 * The parent session lock serializes all callers across child-run creation. A
 * durable attempt marker plus exact child metadata recover an uncertain result.
 */
export async function advancePartnerEnrollment(rootDir:string,p:CrossProjectEnrollment,reviewedRoots:readonly string[],shouldStop?:()=>boolean){
  assertPartnerPlanningOpen(shouldStop);
  validateCrossProjectEnrollment(p);
  if(p.scopes.some(s=>!reviewedRoots.includes(s.projectRootUri)))throw Error('Dependency project outside explicit reviewed roots');
  return withClient(async c=>{
    const locked=(await c.query('select pg_try_advisory_lock(hashtext($1)) as locked',[`cross-project-enrollment:${p.sourceRunId}`])).rows[0]?.locked;
    if(!locked)return {state:'waiting' as const,reason:'Existing Partner enrollment owner is active; no duplicate'};
    let schedulerLocked=false;
    let bookkeeping:{projectId:string;owner:string;fencingToken:string}|undefined;
    try{
      schedulerLocked=Boolean((await c.query("select pg_try_advisory_lock(hashtext('agentflow:queue-coordinator')) as locked")).rows[0]?.locked);
      if(!schedulerLocked)return {state:'waiting' as const,reason:'Existing coordinator is reserving capacity; no duplicate scheduler'};
      const original=(await c.query(`select r.project_id::text,r.run_set_id::text,r.task,r.status,r.evaluation_metadata,p.root_uri,
        exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
        from workflow_runs r join projects p on p.id=r.project_id where r.id=$1`,[p.sourceRunId])).rows[0];
      if(!await partnerEnrollmentWindow(c,p))return {state:'held' as const,reason:'Operational pause/checkpoint boundary; explicit human resume required'};
      let operationalOpen=true;
      const authorized=async()=>{
        operationalOpen=await partnerEnrollmentWindow(c,p);
        const receipts=(await c.query("select metadata from action_receipts where run_id=$1 and agent_id in ('operator','workflow-orchestrator') and action_type='operator_cross_project_enrollment_authorized' and metadata->>'authorizationId'=$2",[p.sourceRunId,p.authorizationId])).rows;
        const revoked=(await c.query("select 1 from action_receipts where run_id=$1 and action_type='operator_cross_project_enrollment_revoked' and metadata->>'authorizationId'=$2 limit 1",[p.sourceRunId,p.authorizationId])).rowCount;
        const busy=original&&(await c.query(`select 1 from workflow_runs where project_id=$1 and run_set_id=$2 and status in ('queued','leased','running')
          union all select 1 from action_approvals a join workflow_runs r on r.id=a.run_id where r.project_id=$1 and r.run_set_id=$2 and a.status in ('pending','executing') limit 1`,[original.project_id,original.run_set_id])).rowCount;
        return Boolean(operationalOpen&&original?.canonical&&original.status!=='cancelled'&&reviewedRoots.includes(original.root_uri)&&!busy&&!revoked
          &&!['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId','suiteId','evaluationId'].some(k=>Object.hasOwn(original.evaluation_metadata??{},k))
          &&!/eval(?:uation)?|training/iu.test(String(original.evaluation_metadata?.source??''))
          &&`${original.project_id}:${original.run_set_id}`===p.originalFamilyId&&acceptanceDigest(original.task)===p.originalTaskHash
          &&receipts.length===1&&receipts[0].metadata?.approvalSource==='direct-human'&&receipts[0].metadata?.approvalDecision==='approved'
          &&receipts[0].metadata?.planDigest===acceptanceDigest(p)&&(await verifyRunReceiptChainOnClient(c,p.sourceRunId)).valid);
      };
      const find=async(_p:CrossProjectEnrollment,s:DependencyScope)=>{
        const rows=(await c.query(`select r.id::text as "runId",r.status,r.project_id::text,r.evaluation_metadata,r.task,r.provider_override,r.model_tier_override,
          (select coalesce(a.metadata->>'reason',a.summary) from action_receipts a where a.run_id=r.id and a.action_type in ('stage_failed','stage_blocked') order by a.created_at desc limit 1) blocker
          from workflow_runs r where r.evaluation_metadata->>'dependencyPlanId'=$1 and r.evaluation_metadata->>'dependencyScopeId'=$2 order by r.started_at limit 2`,[p.id,s.id])).rows;
        if(rows.length>1)throw Error('Duplicate dependency attempts require exact owned reconciliation');
        const row=rows[0];
        if(row&&(row.project_id!==s.projectId||row.evaluation_metadata?.dependencyPlanDigest!==acceptanceDigest(p)||row.task!==s.task
          ||row.provider_override!==s.provider||row.model_tier_override!==s.modelTier||row.evaluation_metadata?.approvalTransfer!==false))throw Error('Dependency identity mismatch');
        return row??null;
      };
      const decision=await advanceCrossProjectEnrollment(p,{
        now:Date.now,operationalOpen:()=>operationalOpen,authorized,find,
        attempted:async(_p,s)=>Boolean((await c.query("select 1 from artifacts where run_id=$1 and uri=$2 and kind='cross_project_enrollment_attempt'",[p.sourceRunId,uri(p,s)])).rowCount),
        accepted:async(_p,s,runId)=>{
          // Never use a foreign approval, parent lifecycle or provider assertion.
          const run=(await c.query('select task,evaluation_metadata from workflow_runs where id=$1 and project_id=$2',[runId,s.projectId])).rows[0];
          const contract=run?.evaluation_metadata?.acceptanceContract;
          const currentConfig=resolveExecutionPolicy(await loadProjectConfig(s.projectRootUri),'local').project;
          if(canonicalJsonHash(currentConfig)!==s.policyHash)return false;
          const currentHash=await sourceSubjectHash(s.projectRootUri,s.sourcePaths);
          if(!contract||contract.originRunId!==runId||contract.projectId!==s.projectId||contract.taskHash!==acceptanceDigest(s.task)
            ||acceptanceDigest(contract.sourcePaths)!==acceptanceDigest(s.sourcePaths)
            ||!(await verifyRunReceiptChainOnClient(c,runId)).valid)return false;
          if(await verifyRepairedRevisionAttestationOnClient(c,runId,currentHash))return true;
          if(currentHash!==contract.subjectHash)return false;
          const artifacts=(await c.query("select content from artifacts where run_id=$1 and kind='stage_output' order by created_at desc limit 20",[runId])).rows;
          const independent=(await c.query("select 1 from workflow_tasks where run_id=$1 and status='completed' and agent_id in ('test-engineer','auto-test-runner','security-reviewer') limit 1",[runId])).rowCount;
          if(!independent)return false;
          for(const row of artifacts){if((await acceptancePreflight(c,runId,row.content?.artifact??row.content)).accepted)return true;}
          return false;
        },
        preflight:(_p,s)=>dependencyEnrollmentPreflight(c,s),
        enroll:async(_p,s)=>{
          assertPartnerPlanningOpen(shouldStop);
          const owner=`queue-partner-enrollment:${p.id}:${s.id}`;
          const intent=await acquireWorkIntent({projectId:s.projectId,owner,objective:'Fresh independently authorized dependency enrollment',fileScopes:s.sourcePaths,ttlSeconds:120});
          try{
            assertPartnerPlanningOpen(shouldStop);
            if(!await authorized())throw Error('Enrollment authority or operational cutoff changed');
            const fresh=await dependencyEnrollmentPreflight(c,s);
            if(!fresh.ok)throw Error(fresh.reason);
            const config=await loadProjectConfig(s.projectRootUri),resolved=resolveExecutionPolicy(config,'local');
            const registration=(await c.query('select profile from projects where id=$1 and root_uri=$2',[s.projectId,s.projectRootUri])).rows[0];
            if(!registration?.profile)throw Error('Existing project registration profile unavailable');
            if(canonicalJsonHash(resolved.project)!==s.policyHash)throw Error('Project policy changed during enrollment');
            for(const path of s.sourcePaths)assertFilePathAllowed(path,resolved.project);
            const subjectHash=await sourceSubjectHash(s.projectRootUri,s.sourcePaths);
            const policy=projectConfigSchema.parse({...resolved.project,actions:{...resolved.project.actions,allowed_write_paths:s.sourcePaths,allowed_commands:enrollmentOfflineCommands(resolved.project,s.sourcePaths)}});
            const workflow=(await loadWorkflows(rootDir)).find(w=>w.id==='build-feature');
            if(!workflow)throw Error('Canonical build workflow unavailable');
            assertPartnerPlanningOpen(shouldStop);
            await seedRegistry([],[{path:`runtime/${workflow.id}.yaml`,value:workflow}]);
            assertPartnerPlanningOpen(shouldStop);
            const originalOwner=`queue-partner-enrollment-record:${p.id}`;
            const held=await acquireWorkIntent({projectId:original.project_id,owner:originalOwner,objective:'Record exact once-only dependency enrollment receipt',fileScopes:['runtime/queue-partner/dependency-enrollment'],ttlSeconds:120});
            bookkeeping={projectId:original.project_id,owner:originalOwner,fencingToken:String(held.fencingToken)};
            assertPartnerPlanningOpen(shouldStop);
            // From the once-only attempt marker onward this is owned work:
            // finish its child/link receipt chain even during graceful drain.
            await tx(c,async()=>{
              await appendActionReceipt(c,{runId:p.sourceRunId,agentId:'workflow-orchestrator',actionType:'cross_project_enrollment_attempt',target:uri(p,s),summary:'Once-only independent project enrollment attempt; no approval transfer or parent acceptance.',metadata:JSON.stringify({planDigest:acceptanceDigest(p),scopeId:s.id,projectId:s.projectId})});
              await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'cross_project_enrollment_attempt',$2,$3::jsonb)",[p.sourceRunId,uri(p,s),JSON.stringify({planDigest:acceptanceDigest(p),scopeId:s.id})]);
            });
            const live=(await c.query(`select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp() and file_scopes=$4::jsonb`,[s.projectId,owner,String(intent.fencingToken),JSON.stringify(s.sourcePaths)])).rowCount;
            if(!live||!await authorized())throw Error('Operational checkpoint boundary or scoped intent lost before creation');
            const child=await createWorkflowRun({projectName:config.project.name,projectRootUri:s.projectRootUri,projectProfile:registration.profile,projectConfig:config,workflow,task:s.task,
              autonomy:String(policy.project.autonomy),policyProfile:resolved.profile,policySnapshot:policy,policySnapshotHash:canonicalJsonHash(policy),providerOverride:s.provider,modelTierOverride:s.modelTier,
              evaluationMetadata:{source:'authorized-project-dependency',dependencyPlanId:p.id,dependencyScopeId:s.id,dependencyPlanDigest:acceptanceDigest(p),dependencyOriginalRunId:p.sourceRunId,dependencyOriginalFamilyId:p.originalFamilyId,approvalTransfer:false,offlineOnly:true,pauseAt:p.pauseAt,...inheritedCodexOrigin(original.evaluation_metadata)},
              acceptanceRequirements:{sourcePaths:s.sourcePaths,subjectHash,deliverables:[{id:'original-requirements',description:p.originalRequirements,requiredGates:s.requiredGates as Array<'implementation'|'verification'|'packaging'|'supervision'>,status:'pending',receipts:{},gaps:[]}]},requesterChannel:'coordinator'});
            await tx(c,async()=>{
              const content={planId:p.id,planDigest:acceptanceDigest(p),scopeId:s.id,projectId:s.projectId,runId:child.runId,navigationOnly:true,approvalTransfer:false};
              await appendActionReceipt(c,{runId:p.sourceRunId,agentId:'workflow-orchestrator',actionType:'cross_project_enrollment_linked',target:child.runId,summary:'Explicit dependency navigation; independent project contract, approvals and acceptance remain separate.',metadata:JSON.stringify(content)});
              await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'cross_project_enrollment_link',$2,$3::jsonb)",[p.sourceRunId,`db://workflow_runs/${p.sourceRunId}/cross_project_enrollment_link/${p.id}/${s.id}`,JSON.stringify(content)]);
            });
            return child.runId;
          }finally{await releaseWorkIntent({projectId:s.projectId,owner,fencingToken:String(intent.fencingToken)});}
        }
      }).catch(error=>({state:'handoff' as const,reason:`Technical dependency enrollment evidence unavailable: ${String(error instanceof Error?error.message:error).slice(0,500)}`}));
      if(shouldStop?.())return decision;
      if(original&&await authorized()){
        assertPartnerPlanningOpen(shouldStop);
        const owner=`queue-partner-enrollment-activity:${p.id}`;
        const intent=await acquireWorkIntent({projectId:original.project_id,owner,objective:'Explain bounded enrollment or autonomous recovery decision',fileScopes:['runtime/queue-partner/activity'],ttlSeconds:120});
        const runId='runId' in decision?decision.runId:undefined;
        const scopeId='scopeId' in decision?decision.scopeId:undefined;
        try{assertPartnerPlanningOpen(shouldStop);await recordQueuePartnerDecision({projectId:original.project_id,runId:p.sourceRunId,familyId:p.originalFamilyId,decision:'outcome',state:`dependency-${decision.state}`,
          what:decision.state==='enrolled'?`Enrolled ${scopeId} as independent project work.`:decision.state==='handoff'?'Partner retains this technical enrollment recovery.':decision.state==='waiting'?'Following the existing independent project execution.':'Dependency remains governed by its original acceptance boundary.',
          why:decision.reason,how:'Exact direct-human plan; separate project policy, fresh contract and fenced intent. Navigation never transfers approval.',
          next:decision.state==='handoff'?'Use the configured Partner model to inspect current evidence and execute a supported scoped recovery; do not blindly clone or replay.':decision.state==='held'?'Recover technical gaps under current authority; unavailable native/external proof remains explicit.':'Follow the existing run and verify its current documented acceptance gates.',requiresPermission:false,
          evidence:[{label:'Original family and preserved history',url:`/runs?relatedTo=${p.sourceRunId}`},...(runId?[{label:'Independent dependency execution',url:`/run?id=${runId}`}]:[])],
          provenance:{priority:0,sourcePathsCount:p.scopes.find(s=>s.id===scopeId)?.sourcePaths.length??0,activeCount:decision.state==='waiting'||decision.state==='enrolled'?1:0,pendingApprovalCount:0}},
          {owner,fencingToken:String(intent.fencingToken)});}
        finally{await releaseWorkIntent({projectId:original.project_id,owner,fencingToken:String(intent.fencingToken)});}
      }
      return decision;
    }finally{
      try{if(bookkeeping)await releaseWorkIntent(bookkeeping);}
      finally{
        try{if(schedulerLocked)await c.query("select pg_advisory_unlock(hashtext('agentflow:queue-coordinator'))");}
        finally{await c.query('select pg_advisory_unlock(hashtext($1))',[`cross-project-enrollment:${p.sourceRunId}`]);}
      }
    }
  });
}

/** Only exact direct-human authorized plans in the reviewed canonical scope. */
export async function advanceAuthorizedPartnerEnrollments(rootDir:string,reviewedRoots:readonly string[],shouldStop?:()=>boolean){
  assertPartnerPlanningOpen(shouldStop);
  const plans=await withClient(async c=>(await c.query(`select a.metadata->'plan' as plan from action_receipts a
    join workflow_runs r on r.id=a.run_id join projects p on p.id=r.project_id
    where a.action_type='operator_cross_project_enrollment_authorized' and a.metadata->>'approvalSource'='direct-human'
      and a.metadata->>'approvalDecision'='approved' and p.root_uri=any($1::text[])
    order by a.created_at limit 4`,[reviewedRoots])).rows);
  if(plans.length>3)throw Error('More than three dependency plans; narrow exact reviewed inventory');
  const results=[];
  for(const row of plans){
    assertPartnerPlanningOpen(shouldStop);
    // A plan's expired boundary persists across restarts. Never auto-resume.
    validateCrossProjectEnrollment(row.plan);
    if(!await withClient(c=>partnerEnrollmentWindow(c,row.plan)))continue;
    results.push({planId:row.plan.id,...await advancePartnerEnrollment(rootDir,row.plan,reviewedRoots,shouldStop)});
  }
  return results;
}

/** Current ownership projection only. Historical blockers stay immutable, but
 * must not be re-presented as vendor-write permission requests after routing. */
export async function verifiedPartnerOwnershipRoutes(reviewedRoots:readonly string[]){
  return withClient(async c=>{
    const records=(await c.query(`select a.run_id::text,a.metadata,r.task,r.project_id::text,r.run_set_id::text,
      exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
      from action_receipts a join workflow_runs r on r.id=a.run_id join projects p on p.id=r.project_id
      where a.agent_id='workflow-orchestrator' and a.action_type='operator_cross_project_enrollment_authorized'
      and p.root_uri=any($1::text[]) order by a.created_at limit 4`,[reviewedRoots])).rows;
    if(records.length>3)throw Error('Narrow exact dependency ownership inventory');
    const result=[];
    for(const record of records){
      const p=record.metadata?.plan as CrossProjectEnrollment;
      try{validateCrossProjectEnrollment(p);}catch{continue;}
      if(!record.canonical||record.run_id!==p.sourceRunId||p.originalFamilyId!==`${record.project_id}:${record.run_set_id}`||p.originalTaskHash!==acceptanceDigest(record.task)||record.metadata.planDigest!==acceptanceDigest(p)
        ||record.metadata.approvalSource!=='direct-human'||record.metadata.approvalDecision!=='approved'
        ||record.metadata.authorizationId!==p.authorizationId||p.scopes.some(s=>!reviewedRoots.includes(s.projectRootUri))
        ||!(await verifyRunReceiptChainOnClient(c,p.sourceRunId)).valid)continue;
      if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='operator_cross_project_enrollment_revoked' and metadata->>'authorizationId'=$2 limit 1",[p.sourceRunId,p.authorizationId])).rowCount)continue;
      const steps=[];let valid=true;
      for(const scope of p.scopes){
        const project=(await c.query(`select p.root_uri,exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical from projects p where p.id=$1`,[scope.projectId])).rows[0];
        if(!project?.canonical||project.root_uri!==scope.projectRootUri||await fs.realpath(scope.projectRootUri)!==scope.projectRootUri){valid=false;break;}
        const children=(await c.query(`select r.id::text,r.status,r.task,r.project_id::text,r.evaluation_metadata from workflow_runs r
          where r.evaluation_metadata->>'dependencyPlanId'=$1 and r.evaluation_metadata->>'dependencyScopeId'=$2 limit 2`,[p.id,scope.id])).rows;
        if(children.length>1){valid=false;break;}
        const child=children[0];
        if(child&&!dependencyOwnershipChildMatches(p,scope,child)){valid=false;break;}
        steps.push({scopeId:scope.id,projectId:scope.projectId,root:scope.projectRootUri,runId:child?.id??null,status:child?.status??'not-enrolled'});
      }
      if(!valid||!steps[0]?.runId)continue;
      result.push({sourceRunId:p.sourceRunId,familyId:p.originalFamilyId,planId:p.id,steps,
        reason:`Product ownership is routed to canonical project ${steps[0].root} (${steps[0].runId}, ${steps[0].status}); downstream integration waits on independent project acceptance. Historical vendor-write denial is not a current permission request.`,
        approvalTransfer:false,acceptance:'unverified'});
    }
    return result;
  });
}

export function dependencyOwnershipChildMatches(p:CrossProjectEnrollment,scope:DependencyScope,child:{project_id:string;task:string;evaluation_metadata?:Record<string,unknown>}):boolean{
  const m=child.evaluation_metadata;
  return child.project_id===scope.projectId&&child.task===scope.task&&m?.dependencyPlanDigest===acceptanceDigest(p)
    &&m?.dependencyPlanId===p.id&&m?.dependencyScopeId===scope.id&&m?.approvalTransfer===false;
}
