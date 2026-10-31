import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import type {Client} from 'pg';
import {projectConfigSchema,type ProjectConfig} from '../../agent-registry/src/schemas.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {assertFilePathAllowed} from '../../local-tools/src/file-writer.js';
import {canonicalJsonHash,evaluateActionApprovalRule,evaluateActionRiskAutoApproval,resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {acceptanceDigest} from './acceptance.js';
import {exactPartnerPaths} from './queue-partner-reasoning.js';
import {captureRepairRevisionManifest,repairRevisionManifestHash,type RepairRevisionManifestEntry} from './repaired-revision.js';
import {withClient} from './client.js';
import {requestActionApproval} from './action-approvals.js';
import {appendActionReceipt} from './receipt-writer.js';
import {acquireWorkIntent,releaseWorkIntent,withProjectExecutionLock} from './reliability.js';
import {activeQueueSourceOnClient} from './queue-source-membership.js';

export type VerificationRecipe=NonNullable<ProjectConfig['actions']['verification_recipes']>[number];
const testPath=(p:string)=>/^tests\/test_[A-Za-z0-9_]+\.py$/u.test(p)||/^[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]s$/u.test(p);
// These belong to separately governed host/device acceptance. A filename is
// never positive evidence of isolation; this negative filter prevents an
// obvious native gate from being mislabeled as an offline recipe proposal.
const separateAcceptance=(p:string)=>/(?:^|[/_.-])(?:native|integration|device|hardware|deployment|install|e2e|acceptance|terminal|audio|pty)(?:[/_.-]|$)|host_service/iu.test(p);
function commandTest(command:string):string|null {
 const module=/^python3 -m unittest (tests\.[A-Za-z0-9_]+)(?: -v)?$/u.exec(command);
 if(module)return `${module[1]!.replaceAll('.','/')}.py`;
 const python=/^python3 -m unittest discover -s tests -p (test_[A-Za-z0-9_]+\.py)(?: -v)?$/u.exec(command);
 if(python)return `tests/${python[1]}`;
 return /^(?:node --import tsx --test|node --test) ([A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]s)$/u.exec(command)?.[1]??null;
}
function validRecipe(r:VerificationRecipe,paths:readonly string[]):boolean {
 return exactPartnerPaths(r.source_paths)&&r.source_paths.length>0&&exactPartnerPaths(r.test_paths)&&r.test_paths.length>0
  &&r.source_paths.every(p=>paths.includes(p))&&r.test_paths.every(p=>r.source_paths.includes(p)&&testPath(p)&&!separateAcceptance(p))
  &&r.output_paths.length===0&&r.commands.length>0&&r.commands.length<=8&&new Set(r.commands).size===r.commands.length
  &&r.commands.every(c=>{const p=commandTest(c);return p!==null&&r.test_paths.includes(p);})
  &&r.test_paths.every(p=>r.commands.some(c=>commandTest(c)===p));
}
/** Literal focused tests only. Declarations, syntax checks and a whole-suite
 * allowlist are not proof that a behavioral recipe can execute. */
export function materializeVerificationRecipes(project:ProjectConfig,paths:readonly string[]):string[]{
 return [...new Set((project.actions.verification_recipes??[]).filter(r=>validRecipe(r,paths)).flatMap(r=>r.commands))]
  .filter(c=>{try{assertCommandAllowed(c,project);return true;}catch{return false;}});
}
export function planPartnerAdmission(project:ProjectConfig,paths:readonly string[]){
 if(!exactPartnerPaths(paths)||!paths.length)throw Error('Exact source/test scope required for repair admission');
 const tests=paths.filter(testPath),separateTests=tests.filter(separateAcceptance),offlineTests=tests.filter(p=>!separateAcceptance(p)),declared=materializeVerificationRecipes(project,paths);
 const allowed=[...declared,...project.actions.allowed_commands.filter(c=>{const p=commandTest(c);return p!==null&&tests.includes(p);})]
  .filter(c=>{try{assertCommandAllowed(c,project);return true;}catch{return false;}});
 const missingTests=tests.filter(p=>!allowed.some(c=>commandTest(c)===p));
 const commands=tests.map(p=>allowed.find(c=>commandTest(c)===p)??(p.endsWith('.py')?`python3 -m unittest discover -s tests -p ${p.slice(6)} -v`:`node --import tsx --test ${p}`));
 const approvalCommands=commands.filter(target=>project.policies.require_approval_for_external_actions
  &&(evaluateActionApprovalRule({project,actionType:'local_command',target})??evaluateActionRiskAutoApproval({project,actionType:'local_command',target}))?.effect!=='auto_execute');
 const recipes:VerificationRecipe[]=offlineTests.map(p=>({source_paths:[...paths].sort(),test_paths:[p],commands:[commands[tests.indexOf(p)]!],output_paths:[]}));
 const missingSeparate=separateTests.filter(p=>missingTests.includes(p)||approvalCommands.some(c=>commandTest(c)===p));
 return {ready:tests.length>0&&!missingTests.length&&!approvalCommands.length,missingTests,approvalCommands,recipes,
  gaps:[...(tests.length?[]:['No bounded behavioral verification recipe was identified for this source scope.']),...missingSeparate.map(p=>`Separately governed host/device acceptance required: ${p}`),...missingTests.map(p=>`Missing exact test command: ${p}`),...approvalCommands.map(c=>`Explicit command approval required: ${c}`)]};
}

export interface PartnerAdmissionPacket {
 version:1;purpose:'partner-recovery-admission';sourceRunId:string;projectId:string;projectRootUri:string;familyId:string;taskHash:string;
 sourcePaths:string[];manifest:RepairRevisionManifestEntry[];sourceHash:string;policyHash:string;configHash:string;
 recipes:VerificationRecipe[];enrollCurrentBaseline:boolean;provider:'codex-cli';modelTier:'standard';offlineOnly:true;
 allowApprovedRecipeAdditions?:boolean;
 historicalContinuity:'unverified';originalAcceptanceChanged:false;
}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export function validatePartnerAdmissionPacket(p:PartnerAdmissionPacket){
 if(p.version!==1||p.purpose!=='partner-recovery-admission'||!p.offlineOnly||p.provider!=='codex-cli'||p.modelTier!=='standard'
  ||p.historicalContinuity!=='unverified'||p.originalAcceptanceChanged!==false||typeof p.enrollCurrentBaseline!=='boolean'
  ||(p.allowApprovedRecipeAdditions!==undefined&&typeof p.allowApprovedRecipeAdditions!=='boolean')
  ||![p.taskHash,p.sourceHash,p.policyHash,p.configHash].every(hash)||!exactPartnerPaths(p.sourcePaths)||!p.sourcePaths.length
  ||!p.recipes.length||p.recipes.length>40||p.recipes.some(r=>!validRecipe(r,p.sourcePaths))
  ||repairRevisionManifestHash(p.manifest)!==p.sourceHash||acceptanceDigest(p.manifest.map(m=>m.path).sort())!==acceptanceDigest([...p.sourcePaths].sort()))throw Error('Invalid exact recovery admission packet');
}
/** Persistent exact project recipes require the disclosed human policy
 * decision. No blocked pattern, write path, native grant or risk threshold is
 * changed; individual source mutations retain their ordinary approval gate. */
export function admittedPartnerProject(project:ProjectConfig,p:PartnerAdmissionPacket):ProjectConfig {
 validatePartnerAdmissionPacket(p);
 const rules=[...project.actions.approval_rules],commands=[...project.actions.allowed_commands],recipes=[...(project.actions.verification_recipes??[])];
 for(const r of p.recipes){
  for(const target of r.commands){
   const probe=projectConfigSchema.parse({...project,actions:{...project.actions,allowed_commands:[...commands,target]}});
   assertCommandAllowed(target,probe); // blocked commands still dominate
   if(!commands.includes(target))commands.push(target);
   if(!rules.some(x=>x.action_type==='local_command'&&x.target===target&&x.effect==='auto_execute'))rules.push({id:`reviewed-recipe-${acceptanceDigest(target).slice(0,16)}`,description:'Exact focused offline recipe approved through Partner admission',action_type:'local_command',target,effect:'auto_execute'});
  }
  if(!recipes.some(x=>acceptanceDigest(x)===acceptanceDigest(r)))recipes.push(r);
 }
 return projectConfigSchema.parse({...project,actions:{...project.actions,allowed_commands:commands,approval_rules:rules,verification_recipes:recipes}});
}

async function checkedSource(c:Client,p:Pick<PartnerAdmissionPacket,'sourceRunId'|'projectId'|'projectRootUri'|'familyId'|'taskHash'>){
 const row=(await c.query(`select r.id::text,r.project_id::text,r.run_set_id::text,r.task,r.status,r.policy_profile,r.evaluation_metadata,p.root_uri,
  exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
  from workflow_runs r join projects p on p.id=r.project_id where r.id=$1`,[p.sourceRunId])).rows[0];
 if(!row?.canonical||row.project_id!==p.projectId||row.root_uri!==p.projectRootUri||`${row.project_id}:${row.run_set_id}`!==p.familyId
  ||acceptanceDigest(row.task)!==p.taskHash||!['blocked','failed','completed'].includes(row.status)||await fs.realpath(row.root_uri)!==row.root_uri
  ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(row.root_uri)||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId','suiteId','evaluationId'].some(k=>Object.hasOwn(row.evaluation_metadata??{},k))
  ||/eval(?:uation)?|training/iu.test(String(row.evaluation_metadata?.source??'')))throw Error('Exact canonical original recovery source required');
 return row;
}
async function verifyIntent(c:Client,p:PartnerAdmissionPacket,owner:string,token:string,includeConfig=false){
 const row=(await c.query(`select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp()`,[p.projectId,owner,token])).rows[0];
 const expected=[...p.sourcePaths,...(includeConfig?['.agent-workflow/project.yaml']:[])].sort();
 if(!row||acceptanceDigest([...row.file_scopes].sort())!==acceptanceDigest(expected))throw Error('Live exact admission intent required');
}
async function assertIdleAdmissionFamily(c:Client,p:PartnerAdmissionPacket,approvalId:string){
 const busy=(await c.query(`with recursive family(id) as (
  select id from workflow_runs where project_id=$2 and run_set_id=(select run_set_id from workflow_runs where id=$3)
  union select child.id from workflow_runs child join family parent on parent.id::text in (
   child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',child.evaluation_metadata->>'repairOriginRunId',child.evaluation_metadata->>'parentRunId') where child.project_id=$2
 ) select 1 from queue_coordinator_assignments where family_id=$1 and state in ('reserved','running','uncertain')
  union all select 1 from workflow_runs r where r.id in(select id from family) and r.status in ('queued','leased','running')
  union all select 1 from workflow_tasks t where t.run_id in(select id from family) and t.status in ('leased','running')
  union all select 1 from action_approvals a where a.run_id in(select id from family) and a.id<>$4 and a.status in ('pending','approved','executing') limit 1`,[p.familyId,p.projectId,p.sourceRunId,approvalId])).rowCount;
 if(busy)throw Error('Existing family work, uncertain effects or another approval must be reconciled first');
}
/** Multiple exact decisions in one project must not invalidate each other
 * merely because another human-approved recipe was installed first. Rebase
 * only through actual executed admission artifacts and their receipt chains;
 * an arbitrary config edit, foreign project or bare artifact is not an edge. */
async function approvedRecipeRebase(c:Client,p:PartnerAdmissionPacket,configHash:string,policyHash:string):Promise<string[]|null>{
 if(!p.allowApprovedRecipeAdditions)return null;
 const rows=(await c.query(`select v.run_id::text,v.uri,v.content,a.id::text approval_id,a.payload
  from artifacts v join workflow_runs r on r.id=v.run_id
  join action_approvals a on a.id::text=v.content->>'approvalId' and a.run_id=v.run_id
  join action_receipts proof on proof.run_id=v.run_id and proof.action_type='action_approval_executed'
   and proof.metadata->>'approvalId'=a.id::text and proof.metadata->>'artifactUri'=v.uri
   and proof.metadata->>'actionType'='partner_recovery_admission' and proof.metadata->>'status'='executed'
  where r.project_id=$1 and v.kind='partner_recovery_admission' and a.action_type='partner_recovery_admission'
   and a.status='executed' and a.decided_by is not null and a.decided_role is not null
  order by v.created_at limit 101`,[p.projectId])).rows;
 if(rows.length>100)return null;
 const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
 let currentConfig=p.configHash,currentPolicy=p.policyHash;const used:string[]=[],verified=new Set<string>();
 for(let step=0;step<=rows.length;step++){
  if(currentConfig===configHash&&currentPolicy===policyHash)return used;
  const edges=rows.filter(r=>r.content?.configBeforeHash===currentConfig&&r.content?.policyBeforeHash===currentPolicy&&!used.includes(r.approval_id)
   &&(r.content.configAfterHash!==currentConfig||r.content.policyAfterHash!==currentPolicy));
  if(edges.length!==1)return null;
  const edge=edges[0],e=edge.content;
  try{validatePartnerAdmissionPacket(e.packet);}catch{return null;}
  if(e.packet.projectId!==p.projectId||e.packet.projectRootUri!==p.projectRootUri||acceptanceDigest(e.packet)!==acceptanceDigest(edge.payload)
   ||!hash(e.configAfterHash)||!hash(e.policyAfterHash)||e.sourceMutationAuthority!==false||e.acceptance!=='unverified')return null;
  if(!verified.has(edge.run_id)){if(!(await verifyRunReceiptChainOnClient(c,edge.run_id)).valid)return null;verified.add(edge.run_id);}
  used.push(edge.approval_id);currentConfig=e.configAfterHash;currentPolicy=e.policyAfterHash;
 }
 return null;
}
export async function requestPartnerAdmission(p:PartnerAdmissionPacket,owner:string,intentFence:string){
 validatePartnerAdmissionPacket(p);const digest=acceptanceDigest(p),key=`partner-admission:${digest}`;
 return withClient(async c=>{
  // Session lock spans requestActionApproval's own canonical transaction.
  await c.query('select pg_advisory_lock(hashtext($1))',[key]);
  try{
   await checkedSource(c,p);await verifyIntent(c,p,owner,intentFence);
   if(!await activeQueueSourceOnClient(c,p.sourceRunId))throw Error('Historical source is outside the active queue');
   const existing=(await c.query(`select id::text,status,payload from action_approvals where run_id=$1 and task_id is null and action_type='partner_recovery_admission' and idempotency_key=$2`,[p.sourceRunId,key])).rows;
   if(existing.length){if(existing.length!==1||acceptanceDigest(existing[0].payload)!==digest)throw Error('Admission approval identity conflict');return {approvalId:existing[0].id,status:existing[0].status};}
   await assertIdleAdmissionFamily(c,p,'00000000-0000-4000-8000-000000000000');
   return await requestActionApproval({runId:p.sourceRunId,stageId:'partner-admission',agentId:'workflow-orchestrator',actionType:'partner_recovery_admission',target:`${p.familyId}:${digest}`,
    rationale:'Before repair, approve the disclosed exact focused offline test recipes and current source ownership baseline. Other independently approved exact recipe additions may be rebased only after their executed receipts are verified. Every other policy/source change requires fresh review. This changes no original requirement, historical acceptance, retry budget, source mutation gate or native/deployment authority.',
    policyDecision:{approvalRequired:true,sourceBound:true,policyHash:p.policyHash,sourceHash:p.sourceHash,persistentExactRecipes:true},payload:p as unknown as Record<string,unknown>,idempotencyKey:key});
  }finally{await c.query('select pg_advisory_unlock(hashtext($1))',[key]);}
 });
}

export async function executePartnerAdmission(input:{approvalId:string;executionClaimToken:string;actor:string}){
 return withClient(async c=>{
  const a=(await c.query(`select * from action_approvals where id=$1 and status='executing' and execution_claim_token=$2::uuid and execution_claim_expires_at>clock_timestamp() and expires_at>clock_timestamp()`,[input.approvalId,input.executionClaimToken])).rows[0];
  if(!a||a.action_type!=='partner_recovery_admission'||!a.decided_by||!a.decided_role||a.executed_by!==input.actor)throw Error('Live approved admission claim required');
  const p=a.payload as PartnerAdmissionPacket;validatePartnerAdmissionPacket(p);
  if(a.run_id!==p.sourceRunId||a.idempotency_key!==`partner-admission:${acceptanceDigest(p)}`||a.target!==`${p.familyId}:${acceptanceDigest(p)}`)throw Error('Admission payload differs from disclosed approval');
  const owner=`partner-admission:${a.id}`,intent=await acquireWorkIntent({projectId:p.projectId,owner,objective:'Apply exact human-reviewed recovery recipe and baseline admission',fileScopes:[...p.sourcePaths,'.agent-workflow/project.yaml'],ttlSeconds:120});
  try{return await withProjectExecutionLock({projectRootUri:p.projectRootUri,resource:'file:.agent-workflow/project.yaml'},async()=>{
   const row=await checkedSource(c,p);await verifyIntent(c,p,owner,String(intent.fencingToken),true);
   if(!await activeQueueSourceOnClient(c,p.sourceRunId))throw Error('Historical source is outside the active queue');
   const {verifyRunReceiptChainOnClient}=await import('./postgres.js');if(!(await verifyRunReceiptChainOnClient(c,p.sourceRunId)).valid)throw Error('Original receipt chain is unverified');
   if(p.enrollCurrentBaseline&&row.evaluation_metadata?.acceptanceContract)throw Error('An existing immutable original contract cannot be replaced');
   const configPath=path.join(p.projectRootUri,'.agent-workflow/project.yaml');
   if(await fs.realpath(configPath)!==configPath)throw Error('Canonical project policy file required');
   const before=await fs.readFile(configPath,'utf8');
   const configBeforeHash=createHash('sha256').update(before).digest('hex');
   const project=resolveExecutionPolicy(await loadProjectConfig(p.projectRootUri),row.policy_profile).project;
   const policyBeforeHash=canonicalJsonHash(project);
   const compatibleApprovals=configBeforeHash===p.configHash&&policyBeforeHash===p.policyHash?[]:await approvedRecipeRebase(c,p,configBeforeHash,policyBeforeHash);
   if(compatibleApprovals===null)throw Error('Project policy/configuration drift outside verified approved recipe additions; fresh exact review required');
   if(project.team.enforcement==='enforce'&&(!project.team.roles[a.decided_role]?.can_approve_actions||!project.team.roles[a.executed_role]?.can_execute_approved_actions))throw Error('Admission role gate denied');
   if(project.team.separation_of_duties.mode==='enforce'&&project.team.separation_of_duties.prevent_same_actor_approval_execution&&a.decided_by===a.executed_by)throw Error('Admission separation of duties denied');
   await assertIdleAdmissionFamily(c,p,a.id);
   for(const file of p.sourcePaths)assertFilePathAllowed(file,project);
   if(repairRevisionManifestHash(await captureRepairRevisionManifest(p.projectRootUri,p.sourcePaths))!==p.sourceHash)throw Error('Scoped source drift; no baseline adoption');
   const next=admittedPartnerProject(project,p),doc=YAML.parseDocument(before);
   for(const field of ['allowed_commands','approval_rules','verification_recipes'] as const)doc.setIn(['actions',field],next.actions[field]);
   const after=doc.toString(),nextConfig=projectConfigSchema.parse(doc.toJS());
   if(!planPartnerAdmission(resolveExecutionPolicy(nextConfig,row.policy_profile).project,p.sourcePaths).ready)throw Error('Profile overrides prevent the exact reviewed verification recipes');
   const backupDir=path.join(p.projectRootUri,'.agent-workflow/runtime/policy-changes');await fs.mkdir(backupDir,{recursive:true});
   await fs.writeFile(path.join(backupDir,`${a.id}.before.yaml`),before,{flag:'wx',mode:0o600});
   const temporary=`${configPath}.${a.id}.tmp`;
   await fs.writeFile(temporary,after,{mode:(await fs.stat(configPath)).mode});
   // Recheck after preparation, immediately before the only policy mutation.
   await verifyIntent(c,p,owner,String(intent.fencingToken),true);
   await checkedSource(c,p);await assertIdleAdmissionFamily(c,p,a.id);
   if(await fs.readFile(configPath,'utf8')!==before||repairRevisionManifestHash(await captureRepairRevisionManifest(p.projectRootUri,p.sourcePaths))!==p.sourceHash)throw Error('Admission input changed before write');
   await fs.rename(temporary,configPath);
   const evidence={approvalId:a.id,packet:p,configBeforeHash,configAfterHash:createHash('sha256').update(after).digest('hex'),policyBeforeHash,
    policyAfterHash:canonicalJsonHash(resolveExecutionPolicy(nextConfig,row.policy_profile).project),compatibleApprovals,
    acceptance:'unverified',historicalContinuity:'unverified',sourceMutationAuthority:false};
   let transaction=false;try{
    await c.query('begin');transaction=true;
    await verifyIntent(c,p,owner,String(intent.fencingToken),true);
    // The existing immutable enrollment and repaired-revision pipeline owns
    // actual baseline capture, candidate chaining and independent acceptance.
    if(p.enrollCurrentBaseline)await appendActionReceipt(c,{runId:p.sourceRunId,agentId:'workflow-orchestrator',actionType:'operator_legacy_recovery_authorized',target:a.id,
     summary:'Exact current baseline authorized by the attributed human admission decision; original history remains unverified.',metadata:JSON.stringify({authorizationId:a.id,sourceRunId:p.sourceRunId,projectId:p.projectId,familyId:p.familyId,taskHash:p.taskHash,sourcePaths:p.sourcePaths,subjectHash:p.sourceHash,provider:p.provider,modelTier:p.modelTier,offlineOnly:true,approvalSource:'direct-human',approvalDecision:'approved',approvalId:a.id,decidedBy:a.decided_by,decidedRole:a.decided_role})});
    await appendActionReceipt(c,{runId:p.sourceRunId,agentId:'workflow-orchestrator',actionType:'partner_recovery_admission_applied',target:a.id,summary:'Reviewed literal verification recipes applied; source mutations and original acceptance remain separately governed.',metadata:JSON.stringify(evidence)});
    const uri=`db://workflow_runs/${p.sourceRunId}/partner_recovery_admission/${a.id}`;
    await c.query(`insert into artifacts(run_id,kind,uri,content) values($1,'partner_recovery_admission',$2,$3::jsonb)`,[p.sourceRunId,uri,JSON.stringify(evidence)]);
    await c.query('commit');transaction=false;return {artifactUri:uri,sourceRunId:p.sourceRunId};
   }catch(e){
    if(transaction)await c.query('rollback').catch(()=>undefined);
    // Never leave an unaudited grant after a failed/uncertain audit commit.
    // Compensation is safe only while the exact policy bytes are still ours.
    let restored=false;
    try{if(await fs.readFile(configPath,'utf8')===after){const restore=`${configPath}.${a.id}.restore.tmp`;await fs.writeFile(restore,before,{mode:(await fs.stat(configPath)).mode});await fs.rename(restore,configPath);restored=true;}}
    catch{/* Keep the original evidence and require explicit reconciliation. */}
    throw Error(`Admission audit failed; ${restored?'configuration restored to its exact preimage':'configuration outcome is uncertain; preserve this approval and reconcile before another action'}. ${e instanceof Error?e.message:String(e)}`);
   }
  });}finally{await releaseWorkIntent({projectId:p.projectId,owner,fencingToken:String(intent.fencingToken)});}
 });
}
