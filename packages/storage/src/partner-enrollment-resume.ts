import {acceptanceDigest} from './acceptance.js';
import type {CrossProjectEnrollment} from './cross-project-enrollment.js';

/** Operational continuation only. The original plan and child contracts never change. */
export interface PartnerEnrollmentResume {
  version:1; resumeId:string; planId:string; planDigest:string; sourceRunId:string;
  approvalSource:'direct-human'; approvalDecision:'approved';
  authorizedAt:string; expiresAt:string; replayAllowed:false; approvalTransfer:false;
}
export function enrollmentResumeOpen(plan:CrossProjectEnrollment,value:unknown,now:number):boolean {
  const r=value as PartnerEnrollmentResume|undefined;
  if(!r||r.version!==1||!/^[-a-z0-9]{1,128}$/iu.test(r.resumeId)
    ||r.planId!==plan.id||r.sourceRunId!==plan.sourceRunId||r.planDigest!==acceptanceDigest(plan)
    ||r.approvalSource!=='direct-human'||r.approvalDecision!=='approved'
    ||r.replayAllowed!==false||r.approvalTransfer!==false)return false;
  const start=Date.parse(r.authorizedAt),end=Date.parse(r.expiresAt);
  return Number.isFinite(start)&&Number.isFinite(end)&&start>=Date.parse(plan.pauseAt)
    &&end>start&&end-start<=24*60*60*1000&&now>=start&&now<end;
}
