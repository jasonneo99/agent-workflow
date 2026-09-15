export type FailureTriageRisk = "low" | "medium" | "high";
export type FailureTriageCategory = "provider" | "dependency" | "runtime" | "validation" | "policy" | "unknown";

export type FailureTriageEvidence = {
  runId: string;
  workflowId: string;
  providerId: string | null;
  taskAttempts: number;
  receipts: Array<{ actionType: string; target: string; summary: string }>;
};

export type FailureTriageDecision = {
  category: FailureTriageCategory;
  risk: FailureTriageRisk;
  signature: string;
  diagnosis: string;
  verification: "provider_readiness" | "dependency_readiness" | "runtime_recovery" | "manual_diagnosis";
  retryAfterVerification: boolean;
};

const highRiskWorkflow = /(?:ship-release|data-migration|incident-response|wide-open|deploy|production)/i;
const highRiskAction = /(?:deploy|publish|release|migration|database|external|network|secret|credential|delete|prune|server_mutation)/i;

function normalizedProvider(evidence: FailureTriageEvidence, text: string): string | null {
  if (evidence.providerId) return evidence.providerId;
  const route = evidence.receipts.find((receipt) => receipt.actionType === "model_route_failed");
  if (route?.target && route.target !== "unknown") return route.target;
  const match = text.match(/\b(openai|anthropic|codex-cli|bedrock|kiro|local|byo|openai-compatible|mock)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function classifyFailureForTriage(evidence: FailureTriageEvidence): FailureTriageDecision {
  const text = evidence.receipts.map((receipt) => `${receipt.actionType} ${receipt.target} ${receipt.summary}`).join(" ").toLowerCase();
  const providerId = normalizedProvider(evidence, text);
  const highRisk = highRiskWorkflow.test(evidence.workflowId) || evidence.receipts.some((receipt) => highRiskAction.test(`${receipt.actionType} ${receipt.target}`));
  if (/provider|model_route|rate.?limit|authentication|configuration is incomplete|endpoint|upstream/.test(text)) {
    return {
      category: "provider",
      risk: highRisk ? "high" : "low",
      signature: `provider:${providerId ?? "unknown"}:${/config|auth|credential/.test(text) ? "configuration" : "execution"}`,
      diagnosis: providerId ? `The ${providerId} execution route failed and should be health-checked before retrying.` : "The model execution route failed and should be health-checked before retrying.",
      verification: "provider_readiness",
      retryAfterVerification: !highRisk
    };
  }
  if (/missing.?tool|command not found|enoent|executable.*not found/.test(text)) {
    return { category: "dependency", risk: highRisk ? "high" : "low", signature: "dependency:missing-tool", diagnosis: "A required local tool was unavailable; retry only after its availability is verified.", verification: "dependency_readiness", retryAfterVerification: false };
  }
  if (/\blease\b|\bstale\b|worker.*(?:stopped|lost)|timeout|timed out|connection reset/.test(text)) {
    return { category: "runtime", risk: highRisk ? "high" : "low", signature: "runtime:interruption", diagnosis: "The run appears to have been interrupted by runtime or worker state; reconcile runtime state before retrying.", verification: "runtime_recovery", retryAfterVerification: !highRisk };
  }
  if (/approval|policy|denied|not allowed|outside.*boundary/.test(text)) {
    return { category: "policy", risk: "high", signature: "policy:blocked", diagnosis: "A policy or approval boundary blocked execution; the daemon must report it without bypassing the gate.", verification: "manual_diagnosis", retryAfterVerification: false };
  }
  if (/test|assert|typecheck|validation|exit code|command.*failed/.test(text)) {
    return { category: "validation", risk: highRisk ? "high" : "medium", signature: "validation:failed", diagnosis: "A command or validation check failed; inspect the concrete output and repair the cause before retrying.", verification: "manual_diagnosis", retryAfterVerification: false };
  }
  return { category: "unknown", risk: highRisk ? "high" : "medium", signature: "unknown:needs-diagnosis", diagnosis: "The available receipts do not prove a safe automatic remediation; preserve the evidence and request focused diagnosis.", verification: "manual_diagnosis", retryAfterVerification: false };
}

export function failureTriageRiskAllowed(risk: FailureTriageRisk, maximum: FailureTriageRisk): boolean {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[risk] <= rank[maximum];
}
