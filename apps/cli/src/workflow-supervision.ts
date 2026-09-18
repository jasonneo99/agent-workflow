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
const DYNAMIC_PRODUCT_DELIVERY_WORKFLOW = /^dynamic-feature-delivery-/u;
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
  const productDeliveryWorkflow = PRODUCT_DELIVERY_WORKFLOWS.has(run.workflowId)
    || DYNAMIC_PRODUCT_DELIVERY_WORKFLOW.test(run.workflowId);
  if (!productDeliveryWorkflow) return null;
  if (!DELIVERY_WORD.test(run.task)) return null;
  if (String(run.evaluationMetadata?.source ?? "") === "workflow-supervisor-repair") return null;
  if (run.status === "completed"
    && run.workflowId !== "build-feature"
    && !DYNAMIC_PRODUCT_DELIVERY_WORKFLOW.test(run.workflowId)
    && !COMPLETION_CONTRACT.test(run.task)) return null;

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

export type WorkflowRepairLesson = {
  outcome: "reinforce" | "avoid" | "observe";
  futureAction: string;
  confidence: number;
  diagnosisOrder: readonly string[];
  prevention: string;
};

export const WORKFLOW_ROOT_REPAIR_DIAGNOSIS_ORDER = [
  "Reconcile parent run state with authoritative child-task state before creating replacement work.",
  "Check whether an equivalent or lineage-linked run already completed; preserve history and dismiss only superseded work.",
  "Verify that an eligible worker can resolve the project checkout before diagnosing the model provider.",
  "Separate approvals, credentials, quotas, and permissions from internal failures; never retry unmet operator prerequisites blindly.",
  "For provider outages, require a bounded real inference probe, not authentication or process-health checks alone.",
  "Treat missing planning detail as a finding unless an actual external prerequisite prevents implementation.",
  "Recover approval executions owned by a prior daemon process before scanning new approvals.",
  "Preserve a blocked stage as a completed checkpoint when every required action has an executed receipt.",
  "Reserve continuation lineage atomically so one terminal source cannot spawn duplicate active replays.",
  "Apply delivery-quality gates only to delivery workflows, never advisory review finalizers.",
  "Allow one lineage-marked repair at a time, retain idempotent receipts, and learn from its verified terminal result."
] as const;

const WORKFLOW_REPAIR_PREVENTION: Record<string, string> = {
  "review-evidence-gap": "Refresh governed project evidence, then replay the original review contract once with checkpoint lineage.",
  "provider-recovered": "Do not trust login or readiness alone; run a bounded inference probe before replaying a provider outage.",
  "provider-inference-recovered": "Retain the successful inference probe as the recovery gate and do not create another blind replay.",
  "build-feature": "Require governed product-write and executed-verification evidence before accepting delivery completion.",
  "debug-failure": "Repair the recorded causal failure, verify it, and suppress duplicate diagnostics for the same lineage.",
  "replay-original": "Replay the original contract with completed checkpoints preserved instead of creating unrelated work.",
  "worker-project-unavailable": "Resolve project checkout availability before claim; exclude unavailable project roots from that worker sweep.",
  "stale-parent-state": "Derive the parent terminal state from child tasks and traverse required lifecycle states idempotently.",
  "planning-deliverable-gap": "Record the gap as a finding and continue to implementation unless a real external prerequisite exists.",
  "provider-cli-contention": "Serialize shared local CLI launches across processes and resolve the executable before spawning workers.",
  "interrupted-approval-execution": "On daemon startup, release only that daemon identity's unfinished execution claims and retry through the idempotent approval executor.",
  "action-resolved-checkpoint": "Once every required action has an executed receipt, preserve the producing stage output as a completed checkpoint instead of rerunning the model.",
  "duplicate-replay-race": "Lock the source run and reserve its replacement id in the replay transaction before another repair lane can create a continuation.",
  "workflow-contract-mismatch": "Scope delivery completion gates by workflow identity so review and audit finalizers remain advisory."
};

export function workflowRepairPrevention(strategy: string): string {
  return WORKFLOW_REPAIR_PREVENTION[strategy]
    ?? "Reclassify the failure from current evidence, apply one bounded lineage-marked repair, and verify the terminal result before reuse.";
}

export function workflowRepairLesson(input: {
  strategy: string;
  repairStatus: string;
  completedTasks: number;
  failedTasks: number;
}): WorkflowRepairLesson {
  const prevention = workflowRepairPrevention(input.strategy);
  if (input.repairStatus === "completed" && input.completedTasks > 0 && input.failedTasks === 0) {
    return {
      outcome: "reinforce",
      futureAction: `Reuse ${input.strategy} for the same root-cause class when policy and evidence still match.`,
      confidence: 0.9,
      diagnosisOrder: WORKFLOW_ROOT_REPAIR_DIAGNOSIS_ORDER,
      prevention
    };
  }
  if (input.repairStatus === "blocked" || input.repairStatus === "failed" || input.failedTasks > 0) {
    return {
      outcome: "avoid",
      futureAction: `Do not blindly repeat ${input.strategy}; reclassify the root cause or surface the unmet prerequisite.`,
      confidence: 0.85,
      diagnosisOrder: WORKFLOW_ROOT_REPAIR_DIAGNOSIS_ORDER,
      prevention
    };
  }
  return {
    outcome: "observe",
    futureAction: `Keep ${input.strategy} under observation until the successor reaches a verified terminal state.`,
    confidence: 0.5,
    diagnosisOrder: WORKFLOW_ROOT_REPAIR_DIAGNOSIS_ORDER,
    prevention
  };
}

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
  const recoverableProjectContextGap = /(?:missing|requires?|needs?|not supplied|not provided|unavailable|insufficient|lacks?)\b/u.test(reason)
    && /\b(?:project-specific context|project context|current project state|roadmap (?:milestones?|state)|working tree details)\b/u.test(reason);
  if (recoverableProjectContextGap) return "replay-original";
  if (reviewWorkflow && evidenceGap) return "replay-original";
  if (input.deliveryReason) return supervisedRepairWorkflowId(input.run, input.deliveryReason);
  if (input.recordedFailure?.trim()) return "debug-failure";
  if (evidenceGap) return "debug-failure";
  return "none";
}
