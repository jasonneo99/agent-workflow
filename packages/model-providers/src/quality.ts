import type { StageExecutionInput, StageExecutionOutput } from "./types.js";

export interface StageQualityScore {
  score: number;
  passed: boolean;
  threshold: number;
  reasons: string[];
  retryRecommended: boolean;
}

export function scoreStageOutput(input: StageExecutionInput, output: StageExecutionOutput): StageQualityScore {
  const threshold = Number(process.env.AGENTFLOW_QUALITY_THRESHOLD ?? 0.62);
  const reasons: string[] = [];
  let score = 0;

  if (output.summary.trim().length >= 40) {
    score += 0.22;
  } else {
    reasons.push("summary is very short");
  }

  const artifact = output.artifact as {
    findings?: unknown;
    nextAction?: unknown;
    requestedCommands?: unknown;
    requestedFileWrites?: unknown;
  };
  const findings = Array.isArray(artifact.findings) ? artifact.findings.filter((item) => typeof item === "string") : [];
  if (findings.length > 0) {
    score += 0.24;
  } else {
    reasons.push("no concrete findings");
  }

  if (typeof artifact.nextAction === "string" && artifact.nextAction.trim().length >= 8) {
    score += 0.16;
  } else {
    reasons.push("missing next action");
  }

  if (mentionsProjectEvidence(input, output)) {
    score += 0.18;
  } else {
    reasons.push("limited project-specific evidence");
  }

  if (Array.isArray(output.requestedCommands) && Array.isArray(output.requestedFileWrites)) {
    score += 0.1;
  }

  if (!looksGeneric(output.summary, findings)) {
    score += 0.1;
  } else {
    reasons.push("output appears generic");
  }

  const normalizedScore = Math.min(1, Number(score.toFixed(2)));
  return {
    score: normalizedScore,
    threshold,
    passed: normalizedScore >= threshold,
    reasons,
    retryRecommended: normalizedScore < threshold
  };
}

function mentionsProjectEvidence(input: StageExecutionInput, output: StageExecutionOutput): boolean {
  const text = [
    output.summary,
    JSON.stringify(output.artifact)
  ].join(" ").toLowerCase();
  return [
    input.projectConfig.project.name,
    "agent",
    "workflow",
    "stage",
    "command",
    "file",
    "test",
    "risk",
    "policy"
  ].some((needle) => needle && text.includes(String(needle).toLowerCase()));
}

function looksGeneric(summary: string, findings: string[]): boolean {
  const text = [summary, ...findings].join(" ").toLowerCase();
  return [
    "as an ai",
    "i cannot",
    "it depends",
    "more context is needed",
    "best practices should be followed"
  ].some((phrase) => text.includes(phrase));
}
