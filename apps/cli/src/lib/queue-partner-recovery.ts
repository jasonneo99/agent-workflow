import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {withClient} from '../../../../packages/storage/src/client.js';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {acquireWorkIntent,releaseWorkIntent} from '../../../../packages/storage/src/reliability.js';
import {assertPartnerPlanningOpen} from './queue-partner-watch.js';
import {enrollLegacyRecovery,type LegacyRecoveryInput} from '../../../../packages/storage/src/legacy-recovery.js';
import {loadProjectConfig} from '../../../../packages/agent-registry/src/loaders.js';
import {resolveExecutionPolicy} from '../../../../packages/policy-engine/src/index.js';
import {assertFilePathAllowed} from '../../../../packages/local-tools/src/file-writer.js';
import {verifyRunReceiptChainOnClient} from '../../../../packages/storage/src/postgres.js';
import {proposePartnerEvidence,recoverOriginalRouteEvidence,discoverableScopeObservation,type PartnerEvidenceResult} from './queue-partner-evidence.js';
import {orderPartnerRecoveryRows,nextPartnerProposalId,nextPartnerEnrollmentId} from './queue-recovery-traversal.js';
import {computeReceiptHash} from '../../../../packages/workflow-engine/src/receipt-chain.js';

// Discovery is body-free and bounded. Revisit only when the authentic chain tip
// changes; this is an observation cache, never an approval or acceptance cache.
const proposalCache=new Map<string,PartnerEvidenceResult>();
let discoveryCursor:string|null=null;
let enrollmentCursor:string|null=null;

/** Paths identify ownership, never permission inheritance. A registered child
 * keeps its own policy, authorization, intent, contract and acceptance gates. */
export async function reviewedCanonicalRoot(root:string,reviewed:readonly string[]){
  if(!path.isAbsolute(root)||path.normalize(root)!==root||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(root))return false;
  const inScope=reviewed.some(parent=>root===parent||(!path.relative(parent,root).startsWith(`..${path.sep}`)
    &&path.relative(parent,root)!=='..'&&!path.isAbsolute(path.relative(parent,root))));
  if(!inScope)return false;
  try{return await fs.realpath(root)===root;}catch{return false;}
}
export interface RecoveryEvidence {
  id:string;projectId:string;runSetId:string;root:string;task:string;status:string;
  canonical:boolean;metadata:Record<string,unknown>;authorization:Record<string,unknown>|null;
  receiptTip?:string;
  policyEvidence?:unknown;
  currentRepair?:{uri:string;content:any;authorization:any;authorityReceipt:any;proofReceipt:any};
}
export function recoverEnrollmentInput(r:RecoveryEvidence):Omit<LegacyRecoveryInput,'owner'|'intentFence'>|{hold:string}{
  const m=r.metadata,a=r.authorization;
  if(!r.canonical)return {hold:'Exact registered canonical ownership unavailable'};
  if(r.status==='cancelled')return {hold:'Cancelled original is preserved; explicit new task authority required'};
  if(m.suiteId||m.evaluationId||/eval(?:uation)?|training/iu.test(String(m.source??'')))return {hold:'Evaluation/training requires its own authorization and budget'};
  if(['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(m,k)))return {hold:'Derived attempt cannot supply original enrollment authority'};
  if(m.acceptanceContract)return {hold:'Existing immutable contract must be reconciled, not replaced by a legacy baseline'};
  if(!a)return {hold:'Exact current-baseline authorization with source paths and provider/tier is required; historical adaptive output is not authority'};
  const paths=a.sourcePaths;
  if(a.sourceRunId!==r.id||a.projectId!==r.projectId||a.familyId!==`${r.projectId}:${r.runSetId}`||a.taskHash!==acceptanceDigest(r.task)
    ||a.approvalSource!=='direct-human'||a.approvalDecision!=='approved'||a.provider!=='codex-cli'||a.modelTier!=='standard'||a.offlineOnly!==true
    ||typeof a.authorizationId!=='string'||!a.authorizationId||!Array.isArray(paths)||!paths.length
    ||new Set(paths).size!==paths.length||paths.length>1000
    ||paths.some(p=>typeof p!=='string'||path.isAbsolute(p)||p.includes('\\')||p.split('/').some(x=>!x||x==='.'||x==='..')||/[?*\[\]{}]/u.test(p)||/(^|\/)(vendor|node_modules|\.git|\.env(?:\..*)?|secrets?|credentials?|id_rsa|id_ed25519)(\/|$)/iu.test(p)))return {hold:'Recovered authorization does not bind this exact original task, project, route and safe source scope'};
  return {sourceRunId:r.id,projectId:r.projectId,familyId:`${r.projectId}:${r.runSetId}`,taskHash:acceptanceDigest(r.task),sourcePaths:paths as string[],authorizationId:a.authorizationId};
}

/** Deduplicate one pass of identical missing-provenance discovery without
 * sharing task bodies, receipts, authority, or enrollment across runs. */
export function recoveryDiscoveryCohortKey(r:Pick<RecoveryEvidence,'projectId'|'authorization'>,hold:string):string|undefined{
 if(r.authorization||!hold.startsWith('Exact current-baseline authorization'))return undefined;
 return `provenance-gap:${r.projectId}:${acceptanceDigest(hold).slice(0,16)}`;
}

/** Bounded, receipt-driven enrollment recovery. No provider, approval, run replay,
 * historical contract rewrite, schema migration or foreign approval copying. */
export async function recoverPartnerEnrollments(reviewedRoots:readonly string[],families:ReadonlySet<string>,execute:boolean,shouldStop?:()=>boolean){
  assertPartnerPlanningOpen(shouldStop);
  const available=await withClient(async c=>Boolean((await c.query("select to_regclass('legacy_recovery_enrollments') name")).rows[0]?.name));
  if(!available)return [{state:'held',reason:'Enrollment storage unavailable; migration needs separate operational authority'}];
  const rows=await withClient(async c=>(await c.query(`select r.id::text,r.project_id::text as "projectId",r.run_set_id::text as "runSetId",p.root_uri as root,p.config as "policyEvidence",r.task,r.status,r.evaluation_metadata as metadata,
    exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical,
    (select a.receipt_hash from action_receipts a where a.run_id=r.id order by a.created_at desc limit 1) as "receiptTip",
    (select jsonb_build_object('uri',v.uri,'content',v.content,'authorization',a.metadata,'authorityReceipt',to_jsonb(a),'proofReceipt',to_jsonb(proof))
      from artifacts v join action_receipts a on a.run_id=v.run_id and a.action_type='operator_current_source_repair_authorized'
        and a.agent_id='workflow-orchestrator'
        and a.metadata->>'authorizationId'=v.content->>'authorizationId'
      join action_receipts proof on proof.run_id=v.run_id and proof.action_type='operator_current_source_repair_verified'
        and proof.target=v.uri and proof.metadata=v.content and proof.agent_id='workflow-orchestrator'
      where v.run_id=r.id and v.kind='current_source_repair_validation'
      order by v.created_at desc limit 1) as "currentRepair",
    (select a.metadata from action_receipts a where a.run_id=r.id and a.agent_id='workflow-orchestrator'
      and a.action_type='operator_legacy_recovery_authorized' order by a.created_at desc limit 1) authorization
    from workflow_runs r join projects p on p.id=r.project_id
    where (r.project_id::text||':'||r.run_set_id::text)=any($1::text[])
      and not exists(select 1 from legacy_recovery_enrollments e where e.source_run_id=r.id)
      and not (coalesce(r.evaluation_metadata,'{}'::jsonb) ?| array['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'])
    order by (exists(select 1 from action_receipts a where a.run_id=r.id and a.action_type='operator_legacy_recovery_authorized')) desc,r.started_at,r.id limit 1001`,[[...families]])).rows as RecoveryEvidence[]);
  if(rows.length>1000)throw Error('Evidence recovery inventory exceeds bounded 1000 originals; narrow exact reviewed families');
  const results:Array<{sourceRunId?:string;state:string;reason:string;enrollmentId?:string;evidence?:PartnerEvidenceResult}>=[];
  let attempted=0,discoveries=0;const discoveryCohorts=new Set<string>();
  // Persistent watches use a stable proposal-ID cursor. A fresh bounded CLI
  // uses an observation-only minute offset, so repeated restarts do not always
  // begin with the first rows. Exact authority always precedes this rotation.
  for(const row of orderPartnerRecoveryRows(rows,discoveryCursor,Math.floor(Date.now()/60000),enrollmentCursor)){
    assertPartnerPlanningOpen(shouldStop);
    row.metadata??={};
    if(!await reviewedCanonicalRoot(row.root,reviewedRoots))continue;
    if(row.status!=='cancelled'&&!row.metadata.suiteId&&!row.metadata.evaluationId&&!/eval(?:uation)?|training/iu.test(String(row.metadata.source??''))
      &&!['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(row.metadata,k))
      &&row.currentRepair&&currentRepairReceiptSegmentValid(row,row.currentRepair)&&currentRepairEvidenceValid(row,row.currentRepair.content,row.currentRepair.authorization)){
      let fresh=true;
      for(const post of row.currentRepair.content.postimages){
        try{
          const target=path.join(row.root,post.path);
          if(await fs.realpath(target)!==target||createHash('sha256').update(await fs.readFile(target)).digest('hex')!==post.hash)fresh=false;
        }catch{fresh=false;}
      }
      if(fresh){results.push({sourceRunId:row.id,state:'source-repaired',reason:'Fresh current-source repair and independent offline evidence recorded; original integrated/native acceptance and historical audit gaps remain separate'});continue;}
    }
    const recovered=recoverEnrollmentInput(row);
    if('hold' in recovered){
      if(!row.authorization&&recovered.hold.startsWith('Exact current-baseline authorization')){
        const cohort=recoveryDiscoveryCohortKey(row,recovered.hold)!;
        if(discoveryCohorts.has(cohort)){
          results.push({sourceRunId:row.id,state:'waiting',reason:`Shared provenance cohort ${cohort} already has a representative in this pass; exact run evidence remains required`});
          continue;
        }
        discoveryCohorts.add(cohort);
        const key=acceptanceDigest({id:row.id,project:row.projectId,family:row.runSetId,canonical:row.canonical,root:row.root,policy:row.policyEvidence,task:row.task,metadata:row.metadata,status:row.status,tip:row.receiptTip,discoveryWindow:Math.floor(Date.now()/300000)});
        let evidence=proposalCache.get(key);
        if(!evidence&&discoveries<3){
          discoveries++;
          discoveryCursor=nextPartnerProposalId(rows,row.id);
          evidence=await withClient(async c=>{
            const chain=(await verifyRunReceiptChainOnClient(c,row.id)).valid;
            const records=(await c.query(`select receipt_hash as reference,action_type as kind,target as path
              from action_receipts where run_id=$1 and action_type in ('file_read','file_write')
              and (target ~ '^(roles|apps|packages|src|tests|scripts|docs)/'
                or (action_type='file_write' and target ~ '^[.]agent-workflow/receipts/[^/]+[.]md$'))
              order by created_at limit 1001`,[row.id])).rows;
            // Keep unsafe returned source observations visible to the proposal
            // validator; never filter them away and manufacture a clean scope.
            const scopeEvidence=records.map(r=>({reference:r.reference,runId:row.id,projectId:row.projectId,chainVerified:chain,
              kind:r.kind==='file_write'?'file-write' as const:'file-read' as const,sourcePaths:[r.path]}));
            if(records.some(r=>r.path.startsWith('.agent-workflow/')&&!discoverableScopeObservation(r.kind,r.path)))return {state:'held' as const,gaps:['Hidden receipt observation is unsafe or outside exact receipt-write discovery scope']};
            const routes=(await c.query(`select a.receipt_hash as reference,a.run_id::text as "runId",r.project_id::text as "projectId",
              jsonb_build_object('route',jsonb_build_object('providerId',a.metadata->'route'->'providerId','modelTier',a.metadata->'route'->'modelTier'),'actualProviderId',a.metadata->'actualProviderId') as metadata
              from action_receipts a join workflow_runs r on r.id=a.run_id where a.run_id=$1 and a.action_type='model_route' order by a.created_at limit 1001`,[row.id])).rows;
            return proposePartnerEvidence({sourceRunId:row.id,projectId:row.projectId,runSetId:row.runSetId,root:row.root,canonical:row.canonical,status:row.status,task:row.task,taskHash:acceptanceDigest(row.task),receiptChainVerified:chain,metadata:row.metadata,
              routeEvidence:recoverOriginalRouteEvidence({sourceRunId:row.id,projectId:row.projectId,chainVerified:chain},routes),
              scopeEvidence});
          });
          if(proposalCache.size>=1000)proposalCache.clear();
          proposalCache.set(key,evidence);
        }
        results.push({sourceRunId:row.id,state:evidence?.state==='proposed'?'proposal':'held',reason:evidence?.state==='proposed'?'Authenticated original source observations recovered; authorize an exact NEW baseline, never infer historical permission':evidence?.state==='held'?evidence.gaps.join('; '):'Bounded evidence discovery pending next pass',...(evidence?{evidence}:{})});
      }else results.push({sourceRunId:row.id,state:'held',reason:recovered.hold});
      continue;
    }
    if(attempted>=3){results.push({sourceRunId:row.id,state:'waiting',reason:'Bounded recovery budget; retain for next pass'});continue;}
    attempted++;
    enrollmentCursor=nextPartnerEnrollmentId(rows,row.id);
    if(!execute){results.push({sourceRunId:row.id,state:'eligible',reason:'Exact scoped enrollment authority recovered; preview only'});continue;}
    const owner=`queue-partner-evidence:${randomUUID()}`;
    let intent:Awaited<ReturnType<typeof acquireWorkIntent>>|undefined;
    try{
      const policy=resolveExecutionPolicy(await loadProjectConfig(row.root),'local').project;
      for(const file of recovered.sourcePaths)assertFilePathAllowed(file,policy);
      assertPartnerPlanningOpen(shouldStop);
      intent=await acquireWorkIntent({projectId:row.projectId,owner,objective:'Recover exact authorized independent project enrollment',fileScopes:recovered.sourcePaths,ttlSeconds:120});
      assertPartnerPlanningOpen(shouldStop);
      // Storage revalidates canonical identity, full receipt chain, original task,
      // exact authority, live fence, pending approvals and source manifest atomically.
      const enrolled=await enrollLegacyRecovery({...recovered,owner,intentFence:String(intent.fencingToken)});
      results.push({sourceRunId:row.id,state:'enrolled',reason:'Fresh independent baseline recovered; original history and gates unchanged',enrollmentId:enrolled.enrollmentId});
    }catch(e){results.push({sourceRunId:row.id,state:'held',reason:`Exact evidence recovery refused: ${String(e instanceof Error?e.message:e).slice(0,400)}`});}
    finally{if(intent)await releaseWorkIntent({projectId:row.projectId,owner,fencingToken:String(intent.fencingToken)});}
  }
  return results;
}

export function currentRepairEvidenceValid(row:RecoveryEvidence,proof:any,auth:any):boolean{
  if(!proof||!auth||!Array.isArray(auth.sourcePaths)||!Array.isArray(proof.sourcePaths)||!Array.isArray(proof.postimages)
    ||proof.sourcePaths.length>1000||new Set(proof.sourcePaths).size!==proof.sourcePaths.length
    ||proof.postimages.some((v:any)=>!v||typeof v.path!=='string'||typeof v.hash!=='string'))return false;
  return Boolean(proof&&auth&&proof.sourceRunId===row.id&&proof.projectId===row.projectId
    &&proof.authorizationId===auth.authorizationId&&auth.projectId===row.projectId
    &&auth.approvalSource==='direct-human'&&auth.approvalDecision==='approved'
    &&auth.originalTaskHash===acceptanceDigest(row.task)&&auth.offlineOnly===true&&auth.replayAllowed===false&&auth.approvalTransfer===false
    &&Array.isArray(auth.authorizedCommands)&&auth.authorizedCommands.includes(proof.command)
    &&proof.exitCode===0&&proof.sourceRepair==='verified'&&proof.independentOfflineReview===true
    &&proof.acceptance==='unverified'&&proof.nativeAcceptance===false&&proof.replay===false&&proof.approvalTransfer===false
    &&Array.isArray(proof.sourcePaths)&&proof.sourcePaths.length>0&&Array.isArray(proof.postimages)
    &&acceptanceDigest(proof.sourcePaths)===acceptanceDigest(auth.sourcePaths)
    &&acceptanceDigest(proof.postimages.map((v:any)=>v.path))===acceptanceDigest(proof.sourcePaths)
    &&proof.postimages.every((v:any)=>typeof v.path==='string'&&!path.isAbsolute(v.path)&&!v.path.includes('\\')
      &&!v.path.split('/').some((p:string)=>!p||p==='.'||p==='..')&&!/(^|\/)(vendor|node_modules|\.git|\.env(?:\..*)?|secrets?|credentials?)(\/|$)/iu.test(v.path)&&/^[a-f0-9]{64}$/u.test(v.hash)));
}

/** Verify the NEW authority→source-proof segment only, never relabel an older
 * incomplete audit chain as verified. Exact run identity commits its family. */
export function currentRepairReceiptSegmentValid(row:RecoveryEvidence,current:NonNullable<RecoveryEvidence['currentRepair']>):boolean{
  try{
    const a=current.authorityReceipt,p=current.proofReceipt;
    if(!a||!p||a.run_id!==row.id||p.run_id!==row.id||a.agent_id!=='workflow-orchestrator'||p.agent_id!=='workflow-orchestrator'
      ||a.action_type!=='operator_current_source_repair_authorized'||p.action_type!=='operator_current_source_repair_verified'
      ||a.target!==current.authorization.authorizationId||p.target!==current.uri||p.prev_hash!==a.receipt_hash
      ||acceptanceDigest(a.metadata)!==acceptanceDigest(current.authorization)||acceptanceDigest(p.metadata)!==acceptanceDigest(current.content))return false;
    return [a,p].every(r=>r.metadata_serialization_version===2&&/^[a-f0-9]{64}$/u.test(r.prev_hash)
      &&r.receipt_hash===computeReceiptHash(r.prev_hash,{runId:r.run_id,agentId:r.agent_id,actionType:r.action_type,target:r.target,summary:r.summary,metadata:JSON.stringify(r.metadata),metadataSerializationVersion:2,createdAt:new Date(r.created_at).toISOString()}));
  }catch{return false;}
}
