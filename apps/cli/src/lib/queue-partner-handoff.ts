export interface QueuePartnerHelpInput {
  projectId: string;
  sourceRunId: string;
  familyId: string;
  failureFingerprint: string;
  reasons: string[];
  pendingApprovalIds?: string[];
  evaluation?: boolean;
  externalProofRequired?: boolean;
}
export interface QueuePartnerHelpNotice {
  projectId: string; sourceRunId: string; familyId: string;
  eventKey: string; title: string; body: string;
}
export interface QueuePartnerHelpAdapter {
  /** Legacy adapter shape; the disabled handback never invokes it. */
  enqueue(notice: QueuePartnerHelpNotice): Promise<{ notificationId: string; reused: boolean } | null>;
}
/** Recovery state changes the next governed action, never its coordination owner.
 * Partner keeps diagnosis, specialist repairs, approval intake and verification,
 * including its own framework defects. Ownership grants no execution authority.
 */
export function partnerRecoveryOwnsNextStep(_recovery: {state:string;reason:string}|undefined):boolean {
  return true;
}

/** Compatibility entry point for older callers. Technical handback is disabled;
 * even a framework code defect stays with Partner's agents. No outbox is read or
 * written, and historical help requests and consumed grants remain untouched.
 */
export async function requestQueuePartnerHelp(_input: QueuePartnerHelpInput, _adapter?: QueuePartnerHelpAdapter): Promise<
  { state: "suppressed"; reason: string }
> {
  return { state: "suppressed", reason: "Partner retains diagnosis, agent repairs, approval intake and independent verification; no technical work is handed back to Codex. Existing execution and approval gates remain enforced." };
}
