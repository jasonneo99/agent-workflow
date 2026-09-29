import type { StageExecutionOutput } from "../../model-providers/src/types.js";

export function shouldRetryWeakFallbackBlock(input: {
  fallbackUsed: boolean;
  actualProviderId: string;
  output: StageExecutionOutput;
  qualityReasons: string[];
}): boolean {
  if (!input.fallbackUsed || input.output.outcome !== "blocked") return false;
  if (input.actualProviderId !== "local" && input.actualProviderId !== "byo" && input.actualProviderId !== "openai-compatible") return false;
  const reason = `${input.output.blockedReason ?? ""} ${input.output.summary}`.toLowerCase();
  const genericBlocker = /missing (?:project )?context|working tree details|collaboration service|could not resolve (?:this )?thread|insufficient context|more context is needed/u.test(reason);
  return genericBlocker || input.qualityReasons.includes("no concrete findings") || input.qualityReasons.includes("limited project-specific evidence");
}

export function shouldContinuePlanningDeliverableGap(input: { stageId: string; output: StageExecutionOutput }): boolean {
  if (input.output.outcome !== "blocked" || !/^(?:orient|plan|inspect|collect)$/u.test(input.stageId)) return false;
  const reason = `${input.output.blockedReason ?? ""} ${input.output.summary}`.toLowerCase();
  const discoverableProjectEvidence = /\b(?:missing|not provided|not present|requires?|needs?|blocked on)\b/u.test(reason)
    && /\b(?:source references?|source files?|paths?|project map|memory records?|architecture|dependencies|data flows?|tests?|implementation details?|project context)\b/u.test(reason);
  const explicitUserChoice = /\b(?:ask|confirm|choose|select|decide|clarify)\b.{0,60}\b(?:user|operator|owner)\b|\b(?:user|operator|owner)\b.{0,60}\b(?:choice|decision|confirmation|clarification)\b/u.test(reason);
  if (discoverableProjectEvidence && !explicitUserChoice) return true;
  if (/\b(?:approval|permission|credential|authentication|authorization|quota|secret|user decision|ambiguous target)\b/u.test(reason)) return false;
  return /\b(?:missing|not provided|not present|requires?|needs?)\b/u.test(reason)
    && /\b(?:project map|memory records?|implementation|deliverables?|architecture|dependencies|data flows?|tests?|source|details|context)\b/u.test(reason);
}
