export type HighRiskApprovalCard = {
  approvalId: string;
  projectId: string | null;
  projectName: string;
  workflowId: string;
  runId: string;
  approvalStatus: string;
  actionType: string;
  target: string;
  rationale: string;
  risk: "high";
  riskReasons: string[];
  requestedAt: string;
  dashboardPath: string;
};

export type HighRiskApprovalInbox = {
  kind: "agentflow_server_high_risk_approval_inbox";
  generatedAt: string;
  status: "ready" | "empty";
  readOnly: true;
  scanned: number;
  open: number;
  highRisk: number;
  items: HighRiskApprovalCard[];
  notes: string[];
};

export function redactApprovalCardText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*([^\s'"`]+)/giu, "$1=[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+/giu, "$1 [REDACTED]")
    .replace(/\/(?:Users|home)\/[^\s'"`]+/gu, "[HOST_PATH]");
  if (redacted.length <= maxLength) return redacted;
  const side = Math.max(1, Math.floor((maxLength - 1) / 2));
  return `${redacted.slice(0, side)}…${redacted.slice(-side)}`;
}

export function buildHighRiskApprovalInbox(input: {
  generatedAt?: string;
  scanned: number;
  open: number;
  items: HighRiskApprovalCard[];
}): HighRiskApprovalInbox {
  const items = input.items.slice(0, 25);
  return {
    kind: "agentflow_server_high_risk_approval_inbox",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: items.length ? "ready" : "empty",
    readOnly: true,
    scanned: input.scanned,
    open: input.open,
    highRisk: items.length,
    items,
    notes: [
      "This endpoint is read-only and never approves, rejects, executes, or dismisses an action.",
      "Targets and rationales are bounded and redact secret-shaped values plus host filesystem paths.",
      "Use the local Agent Workflow approvals dashboard for the human decision."
    ]
  };
}
