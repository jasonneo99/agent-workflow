export type SupervisedRun = {
  workflowId: string;
  task: string;
  status: string;
  evaluationMetadata?: Record<string, unknown>;
};

export type SupervisedStageArtifact = {
  stageId?: string;
  agentId?: string;
  summary?: string;
  artifact?: Record<string, unknown>;
  requestedFileWrites?: unknown;
  requestedCommands?: unknown;
  actionResults?: unknown;
};

export type SupervisedDeliveryReceipt = {
  path: string;
  content: string;
};

const DELIVERY_WORD = /\b(?:build|implement|create|develop|deliver|ship|install|fix|repair|add)\b/iu;
const COMPLETION_CONTRACT = /\b(?:build|deliver|ship|install)\b/iu;
const IMPLEMENTATION_STAGE = /(?:^|[-_])(?:implement(?:ation)?|backend|frontend|database|fix)(?:$|[-_])/iu;
const VERIFICATION_STAGE = /(?:^|[-_])(?:verify|test|validation)(?:$|[-_])/iu;
const PRODUCT_DELIVERY_WORKFLOWS = new Set([
  "accessibility-review",
  "build-feature",
  "data-migration",
  "debug-failure",
  "dependency-upgrade",
  "performance-investigation",
  "wide-open-automation"
]);
export const AUTOMATIC_WORKFLOW_REPAIR_WINDOW_MS = 30 * 60 * 1000;
const RECEIPT_STOP_WORDS = new Set([
  "about", "after", "against", "also", "before", "build", "completed", "create", "deliver", "from", "have", "implement", "into", "local", "original", "preserve", "product", "project", "should", "tests", "that", "their", "these", "this", "through", "verify", "while", "with", "workflow"
]);

function receiptTerms(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/gu) ?? [])
    .filter((term) => !RECEIPT_STOP_WORDS.has(term)));
}

export function findSupersedingDeliveryReceipt(
  task: string,
  receipts: SupervisedDeliveryReceipt[]
): SupervisedDeliveryReceipt | null {
  const taskTerms = receiptTerms(task);
  const taskIds = new Set(task.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu) ?? []);
  for (const receipt of receipts) {
    const text = `${receipt.path}\n${receipt.content}`;
    const completionEvidence = /(?:completion|complete|completed|delivery|delivered|installed|release)/iu.test(receipt.path)
      && /(?:^|\n)#{1,3}\s+(?:completed|verification|installed verification|delivery)/imu.test(receipt.content)
      && /\b(?:passed|installed|delivered|completed|verified)\b/iu.test(receipt.content);
    const disclaimer = /\b(?:planning only|no implementation|no files (?:were )?changed|no tests (?:were )?(?:run|executed))\b/iu.test(receipt.content);
    if (!completionEvidence || disclaimer) continue;
    const receiptIds = new Set(text.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu) ?? []);
    const exactLineage = [...taskIds].some((id) => receiptIds.has(id));
    const terms = receiptTerms(text);
    const overlap = [...taskTerms].filter((term) => terms.has(term));
    const taskCoverage = taskTerms.size ? overlap.length / taskTerms.size : 0;
    if (exactLineage || (overlap.length >= 4 && taskCoverage >= 0.4)) return receipt;
  }
  return null;
}

export function isWithinAutomaticWorkflowRepairWindow(runAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(runAt);
  return Number.isFinite(timestamp)
    && timestamp <= now
    && now - timestamp <= AUTOMATIC_WORKFLOW_REPAIR_WINDOW_MS;
}

export function workflowDeliveryRepairReason(
  run: SupervisedRun,
  outputs: SupervisedStageArtifact[]
): string | null {
  // Auxiliary workflows can carry the original delivery task text, but their
  // contract is review, context, or coordination rather than product writes.
  // Supervising them as deliveries creates repair loops for correctly scoped
  // completions such as maintain-context and review-pr.
  if (!PRODUCT_DELIVERY_WORKFLOWS.has(run.workflowId)) return null;
  if (!DELIVERY_WORD.test(run.task)) return null;
  if (String(run.evaluationMetadata?.source ?? "") === "workflow-supervisor-repair") return null;
  if (run.status === "completed" && run.workflowId !== "build-feature" && !COMPLETION_CONTRACT.test(run.task)) return null;

  const implementation = outputs.filter((item) => IMPLEMENTATION_STAGE.test(item.stageId ?? "")
    || ["implementation-agent", "backend-engineer", "frontend-engineer", "database-engineer"].includes(item.agentId ?? ""));
  const verification = outputs.filter((item) => VERIFICATION_STAGE.test(item.stageId ?? "") || item.agentId === "auto-test-runner");
  const hasProductWrite = implementation.some((item) => {
    const writes = item.requestedFileWrites ?? item.artifact?.requestedFileWrites;
    return Array.isArray(writes) && writes.length > 0;
  });
  const hasExecutedVerification = verification.some((item) => {
    const commands = item.requestedCommands ?? item.artifact?.requestedCommands;
    const actions = item.actionResults ?? item.artifact?.actionResults;
    const text = `${item.summary ?? ""} ${JSON.stringify(item.artifact ?? {})}`;
    const explicitlyMissing = /no (?:tests?|runtime|hardware) (?:were )?(?:run|executed)|(?:remains?|is|was|were) unverified|verification .* (?:absent|unsupported|pending)|promotion gate failed/iu.test(text);
    return !explicitlyMissing && ((Array.isArray(commands) && commands.length > 0) || (Array.isArray(actions) && actions.length > 0));
  });

  if (run.status === "completed" && !hasProductWrite) {
    return "Delivery run was marked completed without governed product-write evidence; planning, receipts, or claims are not implementation.";
  }
  if (run.status === "completed" && !hasExecutedVerification) {
    return "Delivery run was marked completed without executed verification evidence.";
  }
  if (run.status === "blocked" || run.status === "failed") {
    const text = outputs.map((item) => `${item.summary ?? ""} ${JSON.stringify(item.artifact ?? {})}`).join(" ");
    if (/scope(?:d)? authority|policy mismatch|read-only (?:inspection|discovery)|no product files|no (?:files|tests) (?:changed|ran)|implementation .* blocked/iu.test(text)) {
      return "Delivery run stopped before implementation or verification; queue a governed repair within the existing project policy.";
    }
  }
  return null;
}

export function supervisedRepairWorkflowId(run: SupervisedRun, reason: string): "build-feature" | "debug-failure" {
  const deliveryGap = DELIVERY_WORD.test(run.task)
    && /stopped before implementation|without governed product-write evidence|without executed verification evidence|missing implementation|delivery .* incomplete/iu.test(reason);
  return deliveryGap ? "build-feature" : "debug-failure";
}

export type WorkflowRootRepairAction = "replay-original" | "build-feature" | "debug-failure" | "wait-approval" | "operator-provider" | "none";

export function workflowRootRepairAction(input: {
  run: SupervisedRun;
  reason: string;
  deliveryReason?: string | null;
  hasOpenApproval?: boolean;
  recordedFailure?: string;
}): WorkflowRootRepairAction {
  const reason = `${input.reason} ${input.recordedFailure ?? ""}`.toLowerCase();
  if (input.hasOpenApproval || /awaiting approval|required actions .* awaiting approval|approval .* pending/u.test(reason)) {
    return "wait-approval";
  }
  if (/auth(?:entication|orization)?|credential|quota|provider outage|model route|fallback .* failed/u.test(reason)) {
    return "operator-provider";
  }
  const reviewWorkflow = input.run.workflowId === "review-pr"
    || input.run.workflowId === "security-audit"
    || input.run.workflowId === "accessibility-review"
    || input.run.workflowId.startsWith("agent-task-ux-reviewer");
  const evidenceGap = /missing|not supplied|not provided|unavailable|omits?|insufficient|lacks?|unproven/u.test(reason)
    && /context|source|files?|diff|tests?|evidence|repository|implementation|configuration|design system|platform guidance/u.test(reason);
  if (reviewWorkflow && evidenceGap) return "replay-original";
  if (input.deliveryReason) return supervisedRepairWorkflowId(input.run, input.deliveryReason);
  if (input.recordedFailure?.trim()) return "debug-failure";
  if (evidenceGap) return "debug-failure";
  return "none";
}
