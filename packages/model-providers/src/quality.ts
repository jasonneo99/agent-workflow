import type { StageExecutionInput, StageExecutionOutput } from "./types.js";

export interface StageQualityScore {
  score: number;
  passed: boolean;
  threshold: number;
  reasons: string[];
  retryRecommended: boolean;
}

export const PINNED_BUILD_CONTRACT = "BUILD means create, verify, package, and deliver a usable product. Analysis, a plan, documentation, or a handoff is not a build.";

export function hasPinnedBuildIntent(task: string): boolean {
  return /\bbuild\b/iu.test(task);
}

function priorBuildEvidence(input: StageExecutionInput): { productWrite: boolean; verification: boolean } {
  const artifacts = input.priorStageArtifacts ?? [];
  const productWrite = artifacts.some((item) => {
    const writes = item.artifact.requestedFileWrites;
    return Array.isArray(writes) && writes.length > 0;
  });
  const verification = artifacts.some((item) => {
    const isVerifier = /(?:^|[-_])verify(?:$|[-_])/iu.test(item.stageId) || item.agentId === "auto-test-runner";
    if (!isVerifier) return false;
    const text = `${item.summary} ${JSON.stringify(item.artifact)}`;
    return !/(?:remains?|is|was|were) unverified|no (?:tests?|runtime|hardware) (?:were )?(?:run|executed)|verification .* (?:absent|unsupported|pending)/iu.test(text);
  });
  return { productWrite, verification };
}

export function unfulfilledCompletionReason(input: StageExecutionInput, output: StageExecutionOutput): string | null {
  if (output.outcome !== "completed") return null;
  const pinnedBuild = hasPinnedBuildIntent(input.workflowTask);
  const deliveryIntent = /\b(?:build|implement|create|develop|deliver|ship|add|fix)\b/iu.test(input.workflowTask);
  const implementationStage = ["implementation-agent", "backend-engineer", "frontend-engineer", "database-engineer"].includes(input.agentId)
    || /(?:^|[-_])(?:implement(?:ation)?|backend|frontend|database)(?:$|[-_])/iu.test(input.stageId);
  const deliveryFinalizer = deliveryIntent && input.stagePattern?.type === "finalizer";
  const deliveryVerifier = deliveryIntent && (input.stagePattern?.type === "verifier" || input.agentId === "auto-test-runner" || /(?:^|[-_])verify(?:$|[-_])/iu.test(input.stageId));
  if (!implementationStage && !deliveryFinalizer && !deliveryVerifier) return null;
  if (pinnedBuild && (deliveryVerifier || deliveryFinalizer)) {
    const evidence = priorBuildEvidence(input);
    if (!evidence.productWrite) {
      return `Pinned BUILD contract violated: no prior governed product file write proves that a product was created. ${PINNED_BUILD_CONTRACT}`;
    }
    if (deliveryFinalizer && !evidence.verification) {
      return `Pinned BUILD contract violated: no completed verification evidence proves that the created product works. ${PINNED_BUILD_CONTRACT}`;
    }
  }
  if ((output.requestedFileWrites?.length ?? 0) > 0) return null;
  if (deliveryIntent && implementationStage) {
    return "Delivery implementation stage cannot complete without at least one governed product file write; planning or inspection alone does not satisfy the user acceptance contract.";
  }
  const text = `${output.summary} ${JSON.stringify(output.artifact)}`.toLowerCase();
  if (deliveryVerifier && /(?:remains?|is|was|were) unverified|no (?:tests?|runtime|hardware) (?:were )?(?:run|executed)|verification .* (?:absent|unsupported|pending)|promotion .* not approved/iu.test(text)) {
    return "Delivery verification stage claimed completion while explicitly reporting that required verification was not performed.";
  }
  const explicitlyIncomplete = /implementation (?:is|remains) (?:incomplete|blocked|absent)|implementation .* not (?:performed|implemented)|no (?:source |code |project |product )?files? (?:were )?(?:changed|modified|written)|no (?:code|source|product) changes|read-only (?:inspection|discovery)|not implemented|feature delivery .* unsupported|product code remains .* pending|proposal rather than (?:a )?(?:finished|releasable|implemented)/iu.test(text);
  return explicitlyIncomplete ? "Delivery stage claimed completion while explicitly reporting that the requested implementation or finished product was not delivered." : null;
}

export function scoreStageOutput(input: StageExecutionInput, output: StageExecutionOutput): StageQualityScore {
  const threshold = Number(process.env.AGENTFLOW_QUALITY_THRESHOLD ?? 0.62);
  const reasons: string[] = [];
  let score = 0;
  const completionViolation = unfulfilledCompletionReason(input, output);
  if (completionViolation) reasons.push(completionViolation);

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

  const normalizedScore = completionViolation ? 0 : Math.min(1, Number(score.toFixed(2)));
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
