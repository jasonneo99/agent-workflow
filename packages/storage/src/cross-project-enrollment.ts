import { acceptanceDigest } from './acceptance.js';

export interface DependencyScope {
  id:string; projectId:string; projectRootUri:string; task:string; sourcePaths:string[];
  policyHash:string; provider:'codex-cli'; modelTier:'standard'; offlineOnly:true;
  requiredGates:string[]; externalProofRequired:boolean;
}
/** Navigation is shared; every execution contract and permission remains local. */
export interface CrossProjectEnrollment {
  version:1; id:string; sourceRunId:string; originalFamilyId:string; originalTaskHash:string;
  originalRequirements:string; authorizationId:string; approvalTransfer:false;
  startBefore:string; pauseAt:string; scopes:DependencyScope[];
}
export type EnrollmentDecision = {state:'held'|'handoff'|'enrolled'|'waiting'|'accepted'; reason:string; scopeId?:string; runId?:string};
export interface DependencyEnrollmentAdapter {
  now():number;
  /** Optional trusted operational resume; never changes plan/attempt identities. */
  operationalOpen?():boolean;
  /** Verify the exact direct-human plan receipt and original chain, not payload prose. */
  authorized(plan:CrossProjectEnrollment):Promise<boolean>;
  find(plan:CrossProjectEnrollment,scope:DependencyScope):Promise<{runId:string;status:string;blocker?:string}|null>;
  /** Full original gates, independent review, receipt chain and final-source freshness. */
  accepted(plan:CrossProjectEnrollment,scope:DependencyScope,runId:string):Promise<boolean>;
  /** Exact current policy/root, idle capacity, approval and overlap checks. */
  preflight(plan:CrossProjectEnrollment,scope:DependencyScope):Promise<{ok:boolean;reason:string}>;
  /** Durable once-only attempt marker precedes creation; uncertainty must never retry. */
  attempted(plan:CrossProjectEnrollment,scope:DependencyScope):Promise<boolean>;
  enroll(plan:CrossProjectEnrollment,scope:DependencyScope):Promise<string>;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const hash=/^[a-f0-9]{64}$/u;
const gates=['implementation','verification','packaging','supervision'];
export function validateCrossProjectEnrollment(p:CrossProjectEnrollment):void {
  if(!p||p.version!==1||!uuid.test(p.id)||!uuid.test(p.sourceRunId)||!/^[a-z0-9:_-]{1,128}$/iu.test(p.authorizationId)||p.approvalTransfer!==false
    ||typeof p.originalRequirements!=='string'||!p.originalRequirements||p.originalRequirements.length>100000||p.originalTaskHash!==acceptanceDigest(p.originalRequirements)
    ||!p.originalFamilyId?.split(':').every(v=>uuid.test(v))||p.originalFamilyId.split(':').length!==2
    ||!Number.isFinite(Date.parse(p.startBefore))||!Number.isFinite(Date.parse(p.pauseAt))||Date.parse(p.startBefore)>Date.parse(p.pauseAt)
    ||!Array.isArray(p.scopes)||p.scopes.length<2||p.scopes.length>3)throw Error('Invalid exact cross-project enrollment plan');
  const ids=new Set<string>(),projects=new Set<string>(),roots=new Set<string>();
  for(const s of p.scopes){
    if(!s||!uuid.test(s.projectId)||!/^[a-z0-9_-]{1,64}$/iu.test(s.id)||ids.has(s.id)||projects.has(s.projectId)||roots.has(s.projectRootUri)
      ||!s.projectRootUri?.startsWith('/')||s.projectRootUri.split('/').some(v=>v==='..'||v==='.')||/(^|\/)(vendor|node_modules)(\/|$)/u.test(s.projectRootUri)
      ||typeof s.task!=='string'||s.task.length>200000||!s.task.includes(p.originalRequirements)||!hash.test(s.policyHash)||s.provider!=='codex-cli'||s.modelTier!=='standard'||s.offlineOnly!==true
      ||typeof s.externalProofRequired!=='boolean'
      ||!Array.isArray(s.requiredGates)||gates.some(g=>!s.requiredGates.includes(g))
      ||!Array.isArray(s.sourcePaths)||!s.sourcePaths.length||s.sourcePaths.length>1000||new Set(s.sourcePaths).size!==s.sourcePaths.length
      ||s.sourcePaths.some(v=>typeof v!=='string'||!v||v.length>1000||v.startsWith('/')||/[\\*?\[\]{}]/u.test(v)||v.split('/').some(x=>!x||x==='..'||x==='.')||/(^|\/)(?:vendor|node_modules|\.git|\.env(?:\..*)?|credentials?|secrets?|id_rsa|id_ed25519)(\/|$)/iu.test(v)))throw Error('Independent exact project scope and unchanged acceptance gates required');
    ids.add(s.id);projects.add(s.projectId);roots.add(s.projectRootUri);
  }
}
/** At most one fresh enrollment per pass. No replay, approval or acceptance writes. */
export async function advanceCrossProjectEnrollment(p:CrossProjectEnrollment,a:DependencyEnrollmentAdapter):Promise<EnrollmentDecision>{
  validateCrossProjectEnrollment(p);
  const closed=()=>a.operationalOpen ? !a.operationalOpen() : a.now()>=Date.parse(p.startBefore)||a.now()>=Date.parse(p.pauseAt);
  if(closed())return {state:'held',reason:'Operational pause/checkpoint boundary; explicit human resume required'};
  if(!await a.authorized(p))return {state:'handoff',reason:'Exact independent project enrollment authority or original receipt chain unavailable'};
  for(const s of p.scopes){
    if(closed())return {state:'held',reason:'Operational pause/checkpoint boundary; explicit human resume required'};
    const existing=await a.find(p,s);
    if(existing){
      if(['queued','leased','running'].includes(existing.status))return {state:'waiting',scopeId:s.id,runId:existing.runId,reason:'Follow existing independently scoped execution; no duplicate'};
      // Offline enrollment grants no native/deployment/user-acceptance proof.
      // No trusted external-proof adapter is installed in this bounded path.
      if(s.externalProofRequired){
        if(['failed','cancelled'].includes(existing.status)||(existing.status==='blocked'&&!/\b(native|external|physical|intended.host|actual.host)\b/iu.test(existing.blocker??'')))return {state:'handoff',scopeId:s.id,runId:existing.runId,reason:'Technical dependency attempt stopped before external acceptance; inspect exact evidence in Codex, never automatically replay'};
        return {state:'held',scopeId:s.id,runId:existing.runId,reason:'Original external/native proof is still required; offline execution cannot release the downstream project'};
      }
      // A valid independent repaired-revision attestation may accept source
      // whose original failure is immutable. Never rewrite that lifecycle.
      if(await a.accepted(p,s,existing.runId))continue;
      if(existing.status!=='completed')return {state:'handoff',scopeId:s.id,runId:existing.runId,reason:'Existing dependency attempt is terminal; inspect evidence in Codex, never replay automatically'};
      return {state:'held',scopeId:s.id,runId:existing.runId,reason:'Independent acceptance, exact original gates or final-source freshness unavailable'};
    }
    if(await a.attempted(p,s))return {state:'handoff',scopeId:s.id,reason:'Enrollment delivery uncertain; recover exact existing run evidence in Codex, never blindly retry'};
    const check=await a.preflight(p,s);
    if(!check.ok)return {state:'handoff',scopeId:s.id,reason:check.reason};
    if(closed())return {state:'held',reason:'Operational pause/checkpoint boundary; explicit human resume required'};
    return {state:'enrolled',scopeId:s.id,runId:await a.enroll(p,s),reason:'Fresh project-local contract enrolled; original history and foreign approvals unchanged'};
  }
  return {state:'accepted',reason:'Every independent project dependency passed original gates; no parent acceptance mutation'};
}
