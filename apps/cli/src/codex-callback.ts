export const CODEX_CALLBACK_RECEIPT = "codex_attention_delivered";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function attachCodexOrigin(
  metadata: Record<string, unknown> | undefined,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const current = metadata ?? {};
  if (typeof current.codexThreadId === "string" && UUID.test(current.codexThreadId)) return current;
  const threadId = environment.CODEX_THREAD_ID?.trim();
  if (!threadId || !UUID.test(threadId)) return current;
  return {
    ...current,
    originClient: "codex",
    codexThreadId: threadId
  };
}

export function inheritedCodexOrigin(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const threadId = typeof metadata?.codexThreadId === "string" ? metadata.codexThreadId.trim() : "";
  return UUID.test(threadId) ? { originClient: "codex", codexThreadId: threadId } : {};
}

export function codexThreadId(metadata: Record<string, unknown> | undefined): string | null {
  const value = typeof metadata?.codexThreadId === "string" ? metadata.codexThreadId.trim() : "";
  return UUID.test(value) ? value : null;
}

export function approvalCallbackPrompt(input: {
  runId: string;
  workflowId: string;
  projectName: string;
  approvalId: string;
  actionType: string;
  target: string;
  rationale: string;
}): string {
  return [
    "Agent Workflow callback. Do not call tools or change state in this callback turn.",
    `Workflow ${input.workflowId} run ${input.runId} in ${input.projectName} needs approval.`,
    `Approval: ${input.approvalId}`,
    `Requested action: ${input.actionType} on ${input.target}`,
    `Reason: ${input.rationale}`,
    "Ask the user whether to approve and execute, approve only, reject, or dismiss this request.",
    "After the user answers in a later turn, use the Agent Workflow approval tool with that exact approval ID."
  ].join("\n");
}

export function failureCallbackPrompt(input: {
  runId: string;
  workflowId: string;
  projectName: string;
  status: string;
  task: string;
}): string {
  return [
    "Agent Workflow callback. Do not call tools or change state in this callback turn.",
    `Workflow ${input.workflowId} run ${input.runId} in ${input.projectName} is ${input.status}.`,
    `Task: ${input.task}`,
    "Tell the user this run needs attention and ask whether they want Codex to inspect and repair it, retry it, or dismiss it as stale."
  ].join("\n");
}
