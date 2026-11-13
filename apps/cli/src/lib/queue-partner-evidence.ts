import path from 'node:path';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';

export interface OriginalScopeEvidence {
  reference:string;runId:string;projectId:string;chainVerified:boolean;
  kind:'acceptance-requirements'|'task-source-manifest'|'file-read'|'file-write';
  sourcePaths:string[];
}
export interface OriginalRouteEvidence {
  reference:string;runId:string;projectId:string;chainVerified:boolean;provider:string;modelTier:string;
}
/** Historical routing observations only. A complete, exact original chain and
 * agreement between the selected and actual provider are mandatory. These
 * observations never supply current authorization or choose a new route. */
export function recoverOriginalRouteEvidence(context:{sourceRunId:string;projectId:string;chainVerified:boolean},records:readonly {reference:string;runId:string;projectId:string;metadata:any}[]):OriginalRouteEvidence[]{
  if(!context.chainVerified||records.length>1000)return [];
  const observations:OriginalRouteEvidence[]=[];
  for(const record of records){
    const route=record.metadata?.route,actual=record.metadata?.actualProviderId;
    if(record.runId!==context.sourceRunId||record.projectId!==context.projectId||!/^[a-f0-9]{64}$/u.test(record.reference)
      ||typeof route?.providerId!=='string'||!route.providerId.trim()||route.providerId.length>100
      ||actual!==route.providerId||!['fast','standard','reasoning'].includes(route.modelTier))return [];
    observations.push({reference:record.reference,runId:record.runId,projectId:record.projectId,chainVerified:true,provider:route.providerId,modelTier:route.modelTier});
  }
  return observations;
}
export interface PartnerEvidenceInput {
  sourceRunId:string;projectId:string;runSetId:string;root:string;canonical:boolean;
  status:string;task:string;taskHash:string;receiptChainVerified:boolean;
  metadata:Record<string,unknown>;scopeEvidence:OriginalScopeEvidence[];routeEvidence?:OriginalRouteEvidence[];
}
export interface PartnerEvidenceProposal {
  sourceRunId:string;projectId:string;familyId:string;taskHash:string;root:string;
  originalRequirements:string;sourcePaths:string[];evidenceReferences:string[];
  scopeBasis:'explicit-original-manifest'|'governed-original-observations';
  historicalRoute:{provider:string;modelTier:string;references:string[]}|null;
  baselineMode:'new-current-baseline';authority:'none';requiresCurrentAuthorization:true;
}
export type PartnerEvidenceResult={state:'proposed';proposal:PartnerEvidenceProposal}|{state:'held';gaps:string[]};
const safePath=(p:string)=>typeof p==='string'&&p.length>0&&p.length<=1000&&!path.isAbsolute(p)&&!p.includes('\\')
  &&!p.split('/').some(x=>!x||x==='.'||x==='..')&&!/[?*\[\]{}]/u.test(p)
  &&!/(^|\/)(vendor|node_modules|\.git|\.env(?:\..*)?|secrets?|credentials?|id_rsa|id_ed25519)(\/|$)/iu.test(p);

/** Include governed receipt writes in observation discovery without promoting
 * hidden policy/context reads into a requested editable source scope. This is
 * a path filter only: callers still verify original identity and receipt chain.
 */
export function discoverableScopeObservation(kind:string,target:string):boolean {
  if(!['file_read','file_write'].includes(kind)||!safePath(target))return false;
  return /^(roles|apps|packages|src|tests|scripts|docs)\//u.test(target)
    ||kind==='file_write'&&/^\.agent-workflow\/receipts\/[^/]+\.md$/u.test(target);
}

/** Pure proposal only. Callers must load exact authenticated original evidence,
 * validate real canonical paths and enforce current project policy before use.
 * A proposal grants nothing and never claims a historical source preimage. */
export function proposePartnerEvidence(input:PartnerEvidenceInput):PartnerEvidenceResult {
  const gaps:string[]=[];
  if(!input.sourceRunId||!input.projectId||!input.runSetId)gaps.push('Exact original execution identity unavailable');
  if(!input.canonical||!path.isAbsolute(input.root)||path.normalize(input.root)!==input.root||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(input.root))gaps.push('Verified registered canonical project ownership required');
  if(!input.task.trim()||acceptanceDigest(input.task)!==input.taskHash)gaps.push('Authentic full original requirements and task digest required');
  if(!input.receiptChainVerified)gaps.push('Original receipt chain is not verified');
  if(input.status==='cancelled')gaps.push('Cancelled original requires explicit new task authority');
  if(!['failed','blocked','completed'].includes(input.status))gaps.push('Original family must be idle and terminal before baseline proposal');
  if(['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>Object.hasOwn(input.metadata,k)))gaps.push('Derived attempt cannot supply original evidence authority');
  if(Object.hasOwn(input.metadata,'acceptanceContract'))gaps.push('Existing immutable acceptance contract requires reconciliation, not replacement');
  if(input.metadata.suiteId||input.metadata.evaluationId||/eval(?:uation)?|training/iu.test(String(input.metadata.source??'')))gaps.push('Evaluation or training requires independent authorization and budget');
  if(input.scopeEvidence.length>1000||(input.routeEvidence?.length??0)>1000)gaps.push('Evidence exceeds bounded proposal limit');
  const belongs=(e:{runId:string;projectId:string;chainVerified:boolean;reference:string})=>e.runId===input.sourceRunId&&e.projectId===input.projectId&&e.chainVerified&&typeof e.reference==='string'&&e.reference.length>0;
  // Invalid/foreign supplied records are not silently mixed into a proposal.
  if(input.scopeEvidence.some(e=>!belongs(e)||!['acceptance-requirements','task-source-manifest','file-read','file-write'].includes(e.kind)||!Array.isArray(e.sourcePaths)||!e.sourcePaths.length||e.sourcePaths.some(p=>!safePath(p))))gaps.push('Scope evidence contains unverified, foreign or unsafe records');
  const manifests=input.scopeEvidence.filter(e=>e.kind==='acceptance-requirements'||e.kind==='task-source-manifest');
  if(manifests.length>1&&new Set(manifests.map(e=>acceptanceDigest([...new Set(e.sourcePaths)].sort()))).size>1)gaps.push('Original explicit source manifests conflict');
  const selected=manifests.length?manifests:input.scopeEvidence;
  const sourcePaths=[...new Set(selected.flatMap(e=>e.sourcePaths))].sort();
  if(!sourcePaths.length||sourcePaths.length>1000)gaps.push('Exact bounded original source paths unavailable; task prose is insufficient');
  const routes=input.routeEvidence??[];
  if(routes.some(e=>!belongs(e)||!e.provider?.trim()||!['fast','standard','reasoning'].includes(e.modelTier)))gaps.push('Original route evidence is unverified, foreign or invalid');
  const routeKeys=new Set(routes.map(e=>`${e.provider}:${e.modelTier}`));
  if(routeKeys.size>1)gaps.push('Original provider/tier observations conflict');
  if(gaps.length)return {state:'held',gaps};
  return {state:'proposed',proposal:{sourceRunId:input.sourceRunId,projectId:input.projectId,familyId:`${input.projectId}:${input.runSetId}`,taskHash:input.taskHash,root:input.root,
    originalRequirements:input.task,sourcePaths,evidenceReferences:[...new Set(selected.map(e=>e.reference))].sort(),scopeBasis:manifests.length?'explicit-original-manifest':'governed-original-observations',
    historicalRoute:routes.length?{provider:routes[0]!.provider,modelTier:routes[0]!.modelTier,references:routes.map(e=>e.reference).sort()}:null,
    baselineMode:'new-current-baseline',authority:'none',requiresCurrentAuthorization:true}};
}
