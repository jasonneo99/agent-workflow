import type { StageExecutionInput, StageExecutionOutput } from "./types.js";

export interface StageQualityScore {
  score: number;
  passed: boolean;
  threshold: number;
  reasons: string[];
  retryRecommended: boolean;
}

export const PINNED_BUILD_CONTRACT = "BUILD means create, verify, package, and deliver a usable product. Analysis, a plan, documentation, or a handoff is not a build.";

export function workflowAcceptanceTask(task?: string): string {
  let value = (task ?? "").replace(/\r\n/gu, "\n");
  // Incident quotations are evidence, not the active acceptance contract.
  value = value.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?:\n|$)/gmu, "\n")
    .replace(/^[ \t]*>[^\n]*(?:\n|$)/gmu, "\n")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+)?(?:Historical (?:incident )?context|Relevant past context|Past incident)(?:[^\n]*)\n[\s\S]*?(?=^[ \t]*(?:#{1,6}[ \t]+)?(?:Current task|Current acceptance|Required acceptance):|$(?![\s\S]))/gimu, "\n");
  const envelope = /^Repair (?:supervised|blocked) Agent Workflow run [^\n]+\n\s*Original workflow:[^\n]+\n\s*Original task:[ \t]*/u;
  while (envelope.test(value.trim())) {
    const original = value.trim().replace(envelope, "");
    value = original.split(/\n\s*(?:Supervisor finding:|Recorded blocker:|Use the newly refreshed|Preserve the original acceptance)/u)[0].trim();
  }
  return value.trim();
}

export function hasPinnedBuildIntent(task: string): boolean {
  return /\bbuild\b/iu.test(workflowAcceptanceTask(task));
}

function priorBuildEvidence(input: StageExecutionInput): { productDelivery: boolean; verification: boolean } {
  const artifacts = input.priorStageArtifacts ?? [];
  const productDelivery = artifacts.some((item) => {
    return isImplementationStage(item.stageId, item.agentId)
      && (artifactProductWritePaths(item.artifact).some(isProductWritePath) || artifactHasSuccessfulDeliveryCommand(item.artifact));
  });
  const verification = artifacts.some((item) => {
    return isVerificationStage(item.stageId, item.agentId)
      && verificationArtifactIsComplete(item.summary, item.artifact);
  });
  return { productDelivery, verification };
}

export function completedStageProvidesPinnedBuildEvidence(input: {
  workflowTask: string;
  stageId: string;
  agentId: string;
  summary?: string;
  artifact: Record<string, unknown>;
}): boolean {
  if (!hasPinnedBuildIntent(input.workflowTask)) return true;
  if (isImplementationStage(input.stageId, input.agentId)) {
    return artifactProductWritePaths(input.artifact).some(isProductWritePath)
      || artifactHasSuccessfulDeliveryCommand(input.artifact);
  }
  if (isVerificationStage(input.stageId, input.agentId)) {
    return verificationArtifactIsComplete(input.summary ?? String(input.artifact.summary ?? ""), input.artifact);
  }
  return true;
}

function isImplementationStage(stageId: string, agentId: string): boolean {
  return ["implementation-agent", "backend-engineer", "frontend-engineer", "database-engineer"].includes(agentId)
    || /(?:^|[-_])(?:implement(?:ation)?|backend|frontend|database)(?:$|[-_])/iu.test(stageId);
}

function isVerificationStage(stageId: string, agentId: string): boolean {
  return /(?:^|[-_])verify(?:$|[-_])/iu.test(stageId) || agentId === "auto-test-runner";
}

function verificationArtifactIsComplete(summary: string, artifact: Record<string, unknown>): boolean {
  const text = `${summary} ${JSON.stringify(artifact)}`;
  const explicitlyIncomplete = /(?:remains?|is|was|were) unverified|no (?:tests?|runtime|hardware) (?:were )?(?:run|executed)|verification .* (?:absent|unsupported|pending)|(?:product|acceptance|delivery) remains? incomplete/iu.test(text);
  return !explicitlyIncomplete && artifactHasSuccessfulVerificationCommand(artifact);
}

function artifactProductWritePaths(artifact: Record<string, unknown>): string[] {
  const requested = Array.isArray(artifact.requestedFileWrites) ? artifact.requestedFileWrites : [];
  const requestedPaths = requested.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as { path?: unknown }).path === "string"
    ? [(item as { path: string }).path]
    : []);
  const results = Array.isArray(artifact.actionResults) ? artifact.actionResults : [];
  const completedPaths = results.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const result = item as { type?: unknown; path?: unknown };
    return (result.type === "file_write" || result.type === "file_write_reused") && typeof result.path === "string" ? [result.path] : [];
  });
  return [...requestedPaths, ...completedPaths];
}

function isProductWritePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
  return !normalized.startsWith(".agent-workflow/")
    && !normalized.startsWith("docs/receipts/")
    && !/(?:^|\/)receipts?(?:\/|[-_.])/u.test(normalized);
}

function artifactHasSuccessfulVerificationCommand(artifact: Record<string, unknown>): boolean {
  const results = Array.isArray(artifact.actionResults) ? artifact.actionResults : [];
  return results.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const result = item as { commandLine?: unknown; exitCode?: unknown; timedOut?: unknown; type?: unknown };
    const command = typeof result.commandLine === "string" ? result.commandLine : "";
    const verificationCommand = /(?:^|\s|\/)(?:test|tests|check|lint|build|verify|xcodebuild|pytest|unittest|cargo)(?:\s|$)/iu.test(command)
      || /^npm\s+run\s+(?:typecheck|validate-boundary)(?:\s|$)/u.test(command)
      || /^(?:npm\s+exec\s+--\s+)?node\s+(?:--import\s+\S+\s+)?--test(?:\s|$)/u.test(command)
      || isDeliveryCommand(command)
      || /\bxcrun\s+devicectl\s+device\s+(?:info\s+apps|process\s+launch)\b/iu.test(command);
    return verificationCommand && result.exitCode === 0 && result.timedOut !== true && result.type !== "local_command_rejected";
  });
}

function isDeliveryCommand(command: string): boolean {
  return [
    /(?:^|\s)xcodebuild\b[^\n]*(?:^|\s)(?:build|archive)(?:\s|$)/iu,
    /(?:^|\s)(?:ios-deploy\b[^\n]*--bundle|xcrun\s+devicectl\s+device\s+install\s+app|xcrun\s+simctl\s+install)(?:\s|$)/iu,
    /(?:^|\s)(?:swift|cargo|dotnet)\s+(?:build|publish)(?:\s|$)/iu,
    /(?:^|\s)(?:gradle|\.\/gradlew)\s+(?:assemble\w*|build|bundle\w*)(?:\s|$)/iu,
    /(?:^|\s)(?:mvn|\.\/mvnw)\s+(?:package|install)(?:\s|$)/iu,
    /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|bundle|package)(?:\s|$)/iu
  ].some((pattern) => pattern.test(command.trim()));
}

function artifactHasSuccessfulDeliveryCommand(artifact: Record<string, unknown>): boolean {
  const results = Array.isArray(artifact.actionResults) ? artifact.actionResults : [];
  return results.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const result = item as { commandLine?: unknown; exitCode?: unknown; timedOut?: unknown; type?: unknown };
    const command = typeof result.commandLine === "string" ? result.commandLine : "";
    return isDeliveryCommand(command) && result.exitCode === 0 && result.timedOut !== true && result.type !== "local_command_rejected";
  });
}

function outputRequestsDeliveryCommand(output: StageExecutionOutput): boolean {
  return (output.requestedCommands ?? []).some(isDeliveryCommand);
}

export function verificationCompletionReason(input: StageExecutionInput, actionResults: unknown[]): string | null {
  // A current check failure remains actionable even when historical task text
  // mentions delivery. Only a later successful execution clears that failure.
  const latestChecks = new Map<string, Record<string, unknown>>();
  for (const item of actionResults) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const result = item as Record<string, unknown>;
    if (typeof result.commandLine === "string"
      && /^(?:npm\s+(?:test|run\s+(?:check|test|typecheck|validate-boundary))\b|(?:npm\s+exec\s+--\s+)?node\s+.*--test\b)/u.test(result.commandLine.trim())
      && (typeof result.exitCode === "number" || result.exitCode === null)) {
      latestChecks.set(result.commandLine.trim(), result);
    }
  }
  const latestCheck = [...latestChecks.values()].find((result) => result.exitCode !== 0 || result.timedOut === true);
  if (latestCheck && (latestCheck.exitCode !== 0 || latestCheck.timedOut === true)) {
    return `Verification command failed: ${latestCheck.commandLine} (${latestCheck.timedOut === true ? "timed out" : `exit code ${latestCheck.exitCode}`}); see governed command receipt ${latestCheck.artifactUri ?? "in actionResults"}.`;
  }
  const acceptanceTask = workflowAcceptanceTask(input.workflowTask);
  const deliveryIntent = /\b(?:build|implement|create|develop|deliver|ship|add|fix|finish|repair|complete)\b/iu.test(acceptanceTask);
  const deliveryWorkflow = !input.workflowId
    || ["build-feature", "debug-failure", "dependency-upgrade", "data-migration", "wide-open-automation"].includes(input.workflowId);
  const verifier = input.stagePattern?.type === "verifier" || input.agentId === "auto-test-runner" || /(?:^|[-_])verify(?:$|[-_])/iu.test(input.stageId);
  if (!deliveryWorkflow || !deliveryIntent || !verifier) return null;
  const priorActionResults = (input.priorStageArtifacts ?? []).flatMap((item) => {
    const artifact = item.artifact;
    return Array.isArray(artifact.actionResults) ? artifact.actionResults : [];
  });
  const allActionResults = [...priorActionResults, ...actionResults];
  const successfulCommands = allActionResults.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const result = item as { commandLine?: unknown; exitCode?: unknown; timedOut?: unknown; type?: unknown };
    return typeof result.commandLine === "string" && result.exitCode === 0 && result.timedOut !== true && result.type !== "local_command_rejected"
      ? [result.commandLine]
      : [];
  });
  if (/\b(?:install|deploy)\b[\s\S]*\b(?:iphone|ipad|ios|device)\b|\b(?:iphone|ipad|ios|device)\b[\s\S]*\b(?:install|deploy)\b/iu.test(acceptanceTask)
      && !successfulCommands.some((command) => /\bios-deploy\b[^\n]*--bundle|\bxcrun\s+devicectl\s+device\s+install\s+app\b|\bxcrun\s+simctl\s+install\b/iu.test(command))) {
    return "Delivery verification is incomplete: the acceptance task requires device installation, but no successful governed install command receipt exists.";
  }
  if (/\b(?:verify\s+(?:the\s+)?installed\s+bundle\s+identity|installed\s+bundle\s+identity)\b/iu.test(acceptanceTask)
      && !successfulCommands.some((command) => /\bxcrun\s+devicectl\s+device\s+info\s+apps\b|\bios-deploy\b[^\n]*(?:--list_bundle_id|--exists)/iu.test(command))) {
    return "Delivery verification is incomplete: the acceptance task requires installed bundle identity evidence, but no successful governed device-app inspection receipt exists.";
  }
  if (/\b(?:verify[\s\S]{0,40})?launch\b/iu.test(acceptanceTask)
      && !successfulCommands.some((command) => /\bios-deploy\b[^\n]*--bundle|\bxcrun\s+devicectl\s+device\s+process\s+launch\b|\bxcrun\s+simctl\s+launch\b/iu.test(command))) {
    return "Delivery verification is incomplete: the acceptance task requires launch evidence, but no successful governed launch command receipt exists.";
  }
  return artifactHasSuccessfulVerificationCommand({ actionResults: allActionResults })
    ? null
    : "Delivery verification stage cannot complete without a successful governed verification command receipt.";
}

export function unfulfilledCompletionReason(input: StageExecutionInput, output: StageExecutionOutput): string | null {
  if (output.outcome !== "completed") return null;
  const deliveryWorkflow = !input.workflowId
    || ["build-feature", "debug-failure", "dependency-upgrade", "data-migration", "wide-open-automation"].includes(input.workflowId);
  const acceptanceTask = workflowAcceptanceTask(input.workflowTask);
  const pinnedBuild = deliveryWorkflow && hasPinnedBuildIntent(acceptanceTask);
  const deliveryIntent = /\b(?:build|implement|create|develop|deliver|ship|add|fix|finish|repair|complete)\b/iu.test(acceptanceTask);
  const implementationStage = ["implementation-agent", "backend-engineer", "frontend-engineer", "database-engineer"].includes(input.agentId)
    || /(?:^|[-_])(?:implement(?:ation)?|backend|frontend|database)(?:$|[-_])/iu.test(input.stageId);
  const deliveryFinalizer = deliveryWorkflow && deliveryIntent && input.stagePattern?.type === "finalizer";
  const deliveryVerifier = deliveryWorkflow && deliveryIntent && (input.stagePattern?.type === "verifier" || input.agentId === "auto-test-runner" || /(?:^|[-_])verify(?:$|[-_])/iu.test(input.stageId));
  if (!implementationStage && !deliveryFinalizer && !deliveryVerifier) return null;
  if (pinnedBuild && (deliveryVerifier || deliveryFinalizer)) {
    const evidence = priorBuildEvidence(input);
    if (!evidence.productDelivery) {
      return `Pinned BUILD contract violated: no prior governed product file write or successful delivery command proves that a product was created. ${PINNED_BUILD_CONTRACT}`;
    }
    if (deliveryFinalizer && !evidence.verification) {
      return `Pinned BUILD contract violated: no completed verification evidence proves that the created product works. ${PINNED_BUILD_CONTRACT}`;
    }
  }
  // A product write must be substantive: non-empty content that actually changes
  // the file. An empty write or a no-op touch does not prove delivery.
  const hasSubstantiveProductWrite = (output.requestedFileWrites ?? []).some((write) => {
    if (!isProductWritePath(write.path)) return false;
    const content = typeof write.content === "string" ? write.content : "";
    // Require substantive content: at least 100 non-whitespace characters.
    // A 10-char write proves nothing — this rejects empty files, trivial
    // placeholders, and token gestures while allowing legitimate changes.
    // Small but real fixes (a one-line bug fix) still pass via the
    // delivery-command evidence path below.
    return content.replace(/\s/g, "").length >= 100;
  });
  if (hasSubstantiveProductWrite) return null;
  const executedWrites = Array.isArray(output.artifact.actionResults) ? output.artifact.actionResults : [];
  if (executedWrites.some((item) => {
    if (!item || typeof item !== "object") return false;
    const write = item as Record<string, unknown>;
    return write.type === "file_write" && typeof write.path === "string" && isProductWritePath(write.path)
      && typeof write.artifactUri === "string" && write.artifactUri.length > 0
      && typeof write.bytesWritten === "number" && write.bytesWritten >= 10
      && typeof write.nextHash === "string" && write.nextHash.length > 0
      && write.previousHash !== write.nextHash;
  })) return null;
  if (artifactHasSuccessfulDeliveryCommand(output.artifact)) return null;
  // Command-only delivery stages must reach the governed executor before a
  // successful receipt can exist. Recognized build/install requests are not
  // completion evidence here; they only prevent this pre-execution contract
  // check from deadlocking the stage before the executor can run them.
  if (implementationStage && outputRequestsDeliveryCommand(output)) return null;
  if (deliveryWorkflow && deliveryIntent && implementationStage) {
    return "Delivery implementation stage cannot complete without at least one governed product file write or successful delivery command receipt; planning or inspection alone does not satisfy the user acceptance contract.";
  }
  // Verification providers describe commands before the governed executor has
  // run them. Do not treat truthful "results are pending" language as a final
  // completion claim while executable verification requests are still present;
  // the executor will run them and ask the stage to evaluate their receipts.
  if (deliveryVerifier && (output.requestedCommands?.length ?? 0) > 0) return null;
  const text = `${output.summary} ${JSON.stringify(output.artifact)}`.toLowerCase();
  if (deliveryVerifier && /(?:remains?|is|was|were) unverified|no (?:tests?|runtime|hardware) (?:were )?(?:run|executed)|verification .* (?:absent|unsupported|pending)|promotion .* not approved/iu.test(text)) {
    return "Delivery verification stage claimed completion while explicitly reporting that required verification was not performed.";
  }
  const explicitlyIncomplete = /implementation (?:\S+ )*?(?:is|remains?) (?:incomplete|blocked|absent)|implementation .* not (?:performed|implemented)|no (?:source |code |project |product )?files? (?:were )?(?:changed|modified|written)|no (?:code|source|product) changes|read-only (?:inspection|discovery)|not implemented|feature delivery .* unsupported|product code remains .* pending|proposal rather than (?:a )?(?:finished|releasable|implemented)/iu.test(text);
  return explicitlyIncomplete ? "Delivery stage claimed completion while explicitly reporting that the requested implementation or finished product was not delivered." : null;
}

export function scoreStageOutput(input: StageExecutionInput, output: StageExecutionOutput): StageQualityScore {
  const threshold = Number(process.env.AGENTFLOW_QUALITY_THRESHOLD ?? 0.62);
  const reasons: string[] = [];
  let score = 0;
  const completionViolation = unfulfilledCompletionReason(input, output);
  if (completionViolation) reasons.push(completionViolation);
  const blockedOutcome = output.outcome === "blocked";
  if (blockedOutcome) reasons.push("stage outcome is blocked and does not satisfy the expected result");

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

  const normalizedScore = completionViolation ? 0 : Math.min(blockedOutcome ? 0.6 : 1, Number(score.toFixed(2)));
  return {
    score: normalizedScore,
    threshold,
    passed: !blockedOutcome && normalizedScore >= threshold,
    reasons,
    retryRecommended: blockedOutcome || normalizedScore < threshold
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
