export type SuspendResumeCanaryMode = "off" | "shadow" | "authoritative";

export interface SuspendResumeAcceptanceEvidence {
  realExecutorPassed: boolean;
  approvalPassed: boolean;
  rejectionPassed: boolean;
  restartResumePassed: boolean;
  rollbackPassed: boolean;
  receiptChainPassed: boolean;
}

export function suspendResumeCanaryMode(environment: NodeJS.ProcessEnv = process.env): SuspendResumeCanaryMode {
  const value = environment.AGENTFLOW_SUSPEND_RESUME_CANARY?.trim().toLowerCase() || "shadow";
  if (value === "off" || value === "shadow" || value === "authoritative") return value;
  throw new Error("AGENTFLOW_SUSPEND_RESUME_CANARY must be off, shadow, or authoritative.");
}

export function shouldRecordSuspendResumeCanary(environment: NodeJS.ProcessEnv = process.env): boolean {
  return suspendResumeCanaryMode(environment) !== "off";
}

export function evaluateSuspendResumeAcceptance(evidence: SuspendResumeAcceptanceEvidence): {
  accepted: boolean;
  schedulingMode: "shadow" | "authoritative-eligible";
  missing: string[];
} {
  const checks: Array<[keyof SuspendResumeAcceptanceEvidence, string]> = [
    ["realExecutorPassed", "real bound-executor canary"],
    ["approvalPassed", "approval continuation"],
    ["rejectionPassed", "rejection continuation"],
    ["restartResumePassed", "restart while suspended"],
    ["rollbackPassed", "rollback to existing executor"],
    ["receiptChainPassed", "receipt-chain verification"]
  ];
  const missing = checks.filter(([key]) => !evidence[key]).map(([, label]) => label);
  return { accepted: missing.length === 0, schedulingMode: missing.length === 0 ? "authoritative-eligible" : "shadow", missing };
}
