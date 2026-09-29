export type RunPresentation = {
  title: string;
  description: string;
  version: 1;
};

const vagueRequests = new Set([
  "continue", "do it", "do this", "fix it", "help", "investigate", "check", "check again", "retry", "run it", "start"
]);

function humanizeWorkflowId(workflowId: string): string {
  return workflowId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanRequest(task: string): string {
  return task
    .replace(/^\s*(?:#{1,6}|[-*+] |\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeOrchestrationPreamble(task: string): string {
  return task
    .replace(/^GUARDRAIL:.*?authority expansion require explicit approval\.\s*/is, "")
    .replace(/^Continue this durable Agent Workflow conversation\..*?not raw orchestration logs\.\s*/is, "")
    .split(/(?:^|\n)\s*Selected context:\s*/i)[0]
    .trim();
}

function boundedAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const candidate = value.slice(0, max - 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary >= Math.floor(max * 0.6) ? boundary : candidate.length).trimEnd()}…`;
}

function headlineFragment(task: string): string {
  const firstSentence = task.split(/(?<=[.!?])\s|\n|\s[—–-]\s/)[0]?.replace(/[.!?]+$/, "").trim() || task;
  return boundedAtWord(firstSentence, 88);
}

export function buildRunPresentation(input: { task: string; workflowId: string; projectName: string }): RunPresentation {
  const originalTask = cleanRequest(input.task);
  const task = cleanRequest(removeOrchestrationPreamble(input.task));
  const workflow = humanizeWorkflowId(input.workflowId || "workflow");
  const project = cleanRequest(input.projectName) || "this project";
  const normalized = task.toLowerCase().replace(/[.!?]+$/, "");
  const vague = !task || vagueRequests.has(normalized) || task.length < 8;
  const title = vague
    ? `${workflow} for ${project}`
    : `${workflow}: ${headlineFragment(task)}`;
  const description = vague
    ? task
      ? `Complete the ${workflow.toLowerCase()} workflow for ${project}. Original request: “${task}”.`
      : originalTask
        ? `Continue the current requested work for ${project} through the ${workflow.toLowerCase()} workflow. Open “Original request” for the exact submitted context.`
        : `Complete the ${workflow.toLowerCase()} workflow for ${project}. No request text was provided.`
    : `For ${project}: ${boundedAtWord(task, 260)}`;
  return { title: boundedAtWord(title, 120), description, version: 1 };
}

export function storedRunPresentation(value: unknown): RunPresentation | null {
  if (!value || typeof value !== "object") return null;
  const presentation = (value as { presentation?: unknown }).presentation;
  if (!presentation || typeof presentation !== "object") return null;
  const candidate = presentation as Partial<RunPresentation>;
  if (candidate.version !== 1 || typeof candidate.title !== "string" || typeof candidate.description !== "string") return null;
  if (!candidate.title.trim() || !candidate.description.trim()) return null;
  return { title: candidate.title.trim(), description: candidate.description.trim(), version: 1 };
}
