export interface RunOutcomeEvidence {
  productWrites: number;
  successfulVerifications: number;
}

export interface RunOutcomeContract {
  state: "in_progress" | "delivered" | "incomplete" | "needs_input" | "failed" | "advisory_complete";
  title: string;
  detail: string;
  acceptReady: boolean;
  evidence: RunOutcomeEvidence;
  inputPrompt?: string;
  lineageRunIds?: string[];
}

interface OutcomeRun {
  status: string;
  workflowId?: string | null;
  blockedReason?: string | null;
  failedReason?: string | null;
}

interface OutcomeArtifact {
  kind: string;
  content?: Record<string, unknown> | null;
}

export function buildRunOutcomeContract(input: {
  run: OutcomeRun;
  artifacts: OutcomeArtifact[];
  openApprovalCount: number;
  tasks?: Array<{ agentId?: string | null }>;
  lineageRunIds?: string[];
}): RunOutcomeContract {
  const { run, artifacts, openApprovalCount } = input;
  const delivery = run.workflowId === "build-feature"
    || String(run.workflowId ?? "").startsWith("dynamic-feature-delivery-")
    || (input.tasks ?? []).some((task) => task.agentId === "implementation-agent");
  const evidence = {
    productWrites: artifacts.filter((artifact) => artifact.kind === "file_write").length,
    successfulVerifications: artifacts.filter((artifact) => artifact.kind === "command_output" && Number(artifact.content?.exitCode) === 0).length
  };
  if (run.status === "blocked") {
    const reason = run.blockedReason || "Studio stopped at a saved checkpoint before the requested result was delivered.";
    const inputPrompt = openApprovalCount ? undefined
      : /credential|authentication|token|api key/iu.test(reason) ? "Provide or configure the credential named in the blocker, then tell Studio to retry."
      : /choose|decision|which|select/iu.test(reason) ? "State the requested choice or decision so the workflow can continue."
      : /permission|authority/iu.test(reason) ? "Explain whether the requested local authority is granted; external actions still require an approval reply."
      : "Reply with the specific missing information named in the blocker.";
    return {
      state: "needs_input",
      title: openApprovalCount ? "Waiting for your approval" : "Not delivered — workflow needs attention",
      detail: reason,
      acceptReady: false,
      evidence,
      lineageRunIds: input.lineageRunIds,
      inputPrompt
    };
  }
  if (run.status === "failed") {
    return {
      state: "failed",
      title: "Not delivered — workflow failed",
      detail: run.failedReason || "Open the failed stage evidence or try the task again.",
      acceptReady: false,
      evidence,
      lineageRunIds: input.lineageRunIds
    };
  }
  if (run.status === "cancelled") {
    return {
      state: "incomplete",
      title: "Stopped before delivery",
      detail: "This run was cancelled. Its completed evidence is preserved; retry or continue it when you are ready.",
      acceptReady: false,
      evidence,
      lineageRunIds: input.lineageRunIds
    };
  }
  if (run.status !== "completed") {
    return {
      state: "in_progress",
      title: "Work is in progress",
      detail: "Studio will continue automatically unless a real approval or decision is required.",
      acceptReady: false,
      evidence,
      lineageRunIds: input.lineageRunIds
    };
  }
  if (delivery && (!evidence.productWrites || !evidence.successfulVerifications)) {
    return {
      state: "incomplete",
      title: "Stages finished, but the requested outcome is incomplete",
      detail: !evidence.productWrites ? "No governed product change was recorded." : "No successful verification command was recorded.",
      acceptReady: false,
      evidence,
      lineageRunIds: input.lineageRunIds
    };
  }
  if (delivery) {
    return {
      state: "delivered",
      title: "Requested outcome delivered",
      detail: "Changes and verification evidence are ready for review.",
      acceptReady: true,
      evidence,
      lineageRunIds: input.lineageRunIds
    };
  }
  return {
    state: "advisory_complete",
    title: "Requested outcome delivered",
    detail: "The workflow completed its requested advisory work.",
    acceptReady: true,
    evidence,
    lineageRunIds: input.lineageRunIds
  };
}
