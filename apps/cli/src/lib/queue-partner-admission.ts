import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ProjectConfig} from '../../../../packages/agent-registry/src/schemas.js';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {withClient} from '../../../../packages/storage/src/client.js';
import {captureRepairRevisionManifest,repairRevisionManifestHash} from '../../../../packages/storage/src/repaired-revision.js';
import {getLegacyRecoveryEnrollment} from '../../../../packages/storage/src/legacy-recovery.js';
import {planPartnerAdmission,requestPartnerAdmission,type PartnerAdmissionPacket} from '../../../../packages/storage/src/partner-recovery-admission.js';
import {canonicalJsonHash} from '../../../../packages/policy-engine/src/index.js';

/** Proposals carry exact current observations. Only the normal attributed
 * approval executor can install a recipe or authorize a new legacy baseline. */
export async function preparePartnerAdmission(input:{sourceRunId:string;projectId:string;projectRootUri:string;familyId:string;task:string;metadata:any;project:ProjectConfig;paths:string[]}){
 const plan=planPartnerAdmission(input.project,input.paths),manifest=await captureRepairRevisionManifest(input.projectRootUri,input.paths),sourceHash=repairRevisionManifestHash(manifest);
 const enrollment=await getLegacyRecoveryEnrollment(input.sourceRunId);
 const contract=input.metadata?.acceptanceContract??enrollment?.contract;
 if(contract&&(contract.originRunId!==input.sourceRunId||contract.projectId!==input.projectId||contract.taskHash!==acceptanceDigest(input.task)
  ||acceptanceDigest([...(contract.sourcePaths??[])].sort())!==acceptanceDigest([...input.paths].sort())||contract.subjectHash!==sourceHash))
  return {ready:false,reason:'Existing immutable source baseline differs. Use its governed repair/reconciliation and verified postimage chain; another current snapshot cannot adopt this drift.'};
 if(plan.ready&&contract)return {ready:true,reason:'Exact source baseline and executable behavioral recipes are available.'};
 if(!plan.recipes.length||plan.gaps.some(g=>g.startsWith('Separately governed')))return {ready:false,reason:plan.gaps.join('; ')};
 // A newly applied baseline decision is waiting for the existing enrollment
 // pipeline. Do not generate another approval in the intervening tick.
 if(!contract){
  const applied=await withClient(async c=>(await c.query(`select 1 from action_receipts where run_id=$1 and action_type='operator_legacy_recovery_authorized'
   and metadata->>'subjectHash'=$2 and metadata->>'approvalSource'='direct-human' limit 1`,[input.sourceRunId,sourceHash])).rowCount);
  if(applied)return {ready:false,reason:'The exact current baseline is authorized; waiting for existing immutable enrollment, not another worker or approval.'};
 }
 const packet:PartnerAdmissionPacket={version:1,purpose:'partner-recovery-admission',sourceRunId:input.sourceRunId,projectId:input.projectId,projectRootUri:input.projectRootUri,
  familyId:input.familyId,taskHash:acceptanceDigest(input.task),sourcePaths:[...input.paths].sort(),manifest,sourceHash,policyHash:canonicalJsonHash(input.project),
  configHash:createHash('sha256').update(await fs.readFile(path.join(input.projectRootUri,'.agent-workflow/project.yaml'))).digest('hex'),
  recipes:plan.recipes,enrollCurrentBaseline:!contract,provider:'codex-cli',modelTier:'standard',offlineOnly:true,allowApprovedRecipeAdditions:true,historicalContinuity:'unverified',originalAcceptanceChanged:false};
 return {ready:false,reason:[...plan.gaps,...(!contract?['Exact current-source ownership baseline requires its own human decision.']:[])].join('; '),packet};
}

export async function enforcePartnerAdmission(prepared:Awaited<ReturnType<typeof preparePartnerAdmission>>,owner:string,intentFence:string){
 if(prepared.ready)return {ready:true,reason:prepared.reason};
 if(!prepared.packet)return {ready:false,reason:prepared.reason};
 const approval=await requestPartnerAdmission(prepared.packet,owner,intentFence);
 return {ready:false,reason:prepared.reason,approvalId:approval.approvalId,approvalStatus:approval.status};
}
