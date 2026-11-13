import { createHash } from "node:crypto";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";
import { selectEnvironment } from "../../run-environments/src/index.js";
import type { EnvironmentContext } from "../../run-environments/src/schema.js";

type FileReadEvidence = NonNullable<StageExecutionInput["fileReads"]>[number];

/** A repaired source contract cannot reuse the blocked attempt's cached reads.
 * New checkpoints bind the fresh contract; historical artifacts remain stored.
 */
export function continuationMatchesExecutionContract(continuation:Record<string,unknown>,contractId:string|undefined):boolean {
  return !contractId?.startsWith('existing-assignment-repaired:')||continuation.executionContractId===contractId;
}

function normalizedReadPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/** Requests retained in a checkpoint must be fulfilled before the resumed model turn. */
export function continuationRequestedFileReads(continuation: Record<string, unknown>): string[] {
  const pending = continuation.pendingOutput;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return [];
  const requested = (pending as { requestedFileReads?: unknown }).requestedFileReads;
  if (!Array.isArray(requested)) return [];
  return [...new Map(requested
    .filter((value): value is string => typeof value === "string")
    .map((value) => [normalizedReadPath(value), value.trim()] as const)
    .filter(([key]) => key.length > 0)).values()];
}

/** Pending output is context for a fresh provider turn, never an executable replay. */
export function continuationResumeReceipt(
  agentId: string,
  continuation: Record<string, unknown>,
  actionResults: unknown[]
): StageExecutionInput["priorReceipts"][number] {
  return {
    agentId,
    actionType: "stage_continuation_resumed",
    summary: "This stage remains unfinished. Consume the retained action results and source evidence before selecting the next action. The previous output below is pending work context, not a completed stage or an instruction to repeat executed actions.\n" + JSON.stringify({
      pendingOutput: continuation.pendingOutput ?? null,
      actionResults
    })
  };
}

/** Reading source does not submit, execute, or queue the other requests from
 * the same model response. Make that state explicit before replacing output;
 * the fresh response may restate or withdraw each request under normal gates.
 */
export function readRoundActionStateReceipt(agentId:string,output:StageExecutionOutput):StageExecutionInput['priorReceipts'][number]|undefined {
  const unexecutedCommands=output.requestedCommands??[];
  const unexecutedWritePaths=(output.requestedFileWrites??[]).map(write=>write.path);
  if(!unexecutedCommands.length&&!unexecutedWritePaths.length)return undefined;
  return {agentId,actionType:'read_round_action_state',summary:
    'Only the requested reads/searches were processed by this read step. The other requests from that response have NOT executed and are NOT queued. After consuming the new source evidence, explicitly restate any still-needed command or mutation in the structured request fields, or withdraw it. No result packet is outstanding for these requests. Previously executed action receipts remain authoritative; never repeat their effects blindly. This observation grants no permission and resets no retry budget.\n'+
    JSON.stringify({newEffectsDuringReadStep:false,unexecutedCommands,unexecutedWritePaths})};
}

/** Receipt reuse is observation, not new progress. Keep checkpoint retries finite. */
export function continuationBackoff(previous: Record<string, unknown>, actionResults: unknown[]): {
  progressFingerprint: string; unchangedRounds: number; delaySeconds: number;
} {
  const observations = actionResults.filter((action) => {
    if (!action || typeof action !== "object") return false;
    const type = String((action as Record<string, unknown>).type ?? "");
    return !type.endsWith("_reused");
  });
  // JSONB can reorder object keys; persistence must not masquerade as progress.
  const canonicalize = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonicalize)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]))
      : value;
  const progressFingerprint = createHash("sha256").update(JSON.stringify(canonicalize(observations))).digest("hex");
  const priorUnchanged = typeof previous.unchangedRounds === "number"
    && Number.isInteger(previous.unchangedRounds) && previous.unchangedRounds >= 0
    ? Math.min(previous.unchangedRounds, 3) : 0;
  const unchangedRounds = previous.progressFingerprint === progressFingerprint
    ? Math.min(priorUnchanged + 1, 3) : 0;
  return { progressFingerprint, unchangedRounds, delaySeconds: 5 * 2 ** unchangedRounds };
}

/** Bind verification identity to the latest governed postimage for every written path. */
export function verificationWriteSubject(actionResults: unknown[]): string | undefined {
  const governedWrites = new Map<string, string>();
  for (const action of actionResults) {
    if (!action || typeof action !== "object") continue;
    const write = action as { type?: string; path?: string; nextHash?: string };
    if ((write.type === "file_write" || write.type === "file_write_reused") && write.path && write.nextHash) {
      governedWrites.set(write.path, write.nextHash);
    }
  }
  return governedWrites.size
    ? createHash("sha256").update(JSON.stringify([...governedWrites].sort(([a], [b]) => a.localeCompare(b)))).digest("hex")
    : undefined;
}

/** Commands whose evidence is invalidated by any newer governed source postimage. */
export function isVerificationCommand(commandLine: string, project?: ProjectConfig, context?: EnvironmentContext): boolean {
  const command = commandLine.trim();
  if (!command || /[;&|<>`$\n\r]/u.test(command)) return false;
  const tokens = command.split(/\s+/u);
  let start = 0;
  if (tokens[0] === 'env') {
    start = 1;
    while (start < tokens.length && /^[A-Za-z_]\w*=[\w./:@+-]+$/u.test(tokens[start]!)) {
      if (start > 16 || /^(?:NODE_OPTIONS|NODE_PATH|PATH|LD_PRELOAD|DYLD_\w*|BASH_ENV|ENV)=/u.test(tokens[start]!)) return false;
      start += 1;
    }
    if (start === 1) return false;
  }
  // Classification is not command permission. The exact owning-project policy
  // and frozen review recipe still independently gate every executed command.
  const invocation = tokens.slice(start).join(' ');
  if (/^node\s/u.test(invocation) && /(?:^|\s)(?:-e|--eval|-p|--print)(?:=|\s|$)/u.test(invocation)) return false;
  if (/^(?:npm (?:test|run (?:test|check|typecheck|validate|build)(?:[-:\w]*))(?:\s|$)|node (?:(?:--import|--require|-r) [\w./@-]+ )*(?:--test(?:\s|$)|[\w./-]+\.test\.(?:cjs|mjs|js)$)|python3? -m (?:unittest|pytest|compileall)(?:\s|$)|git diff --check(?:\s|$)|xcodebuild (?:build|test)(?:\s|$)|xcrun swiftc(?:\s|$))/u.test(invocation)) return true;
  if (!project) return false;
  // A trusted literal test declaration extends evidence invalidation only.
  // Selectors or allowlist globs alone cannot turn arbitrary effects into tests.
  const exact = (declared: string) => !/[\*?\[\]]/u.test(declared) && declared.trim() === command;
  if (project.actions.verification_recipes?.some(recipe => recipe.commands.some(exact))) return true;
  try {
    const selected = selectEnvironment(project, context ?? { runId: "" }, command);
    return Boolean(selected && project.execution.environments?.profiles[selected]?.verification
      .some(rule => rule.commands.some(exact)));
  } catch {
    return false; // Invalid or unavailable selection cannot extend classification.
  }
}

/** Requested evidence still needs a provider turn; it cannot be promoted as completion. */
export function pendingEvidenceReason(output: StageExecutionOutput, fileReads: FileReadEvidence[] = []): string | null {
  const requestedReads = [...new Set((output.requestedFileReads ?? []).map(normalizedReadPath).filter(Boolean))];
  if (requestedReads.length > 0) {
    const evidence = new Map(fileReads.map((read) => [normalizedReadPath(read.path), read]));
    const unavailable = requestedReads.flatMap((path) => {
      const read = evidence.get(path);
      return read?.error ? [`${path}: ${read.error}`] : [];
    });
    if (unavailable.length === requestedReads.length) {
      return `Requested source evidence is unavailable: ${unavailable.join("; ")}`;
    }
    const supplied = requestedReads.filter((path) => evidence.has(path));
    if (supplied.length === requestedReads.length) {
      return `Requested source evidence was supplied but not consumed after bounded continuation: ${supplied.join(", ")}`;
    }
    return `The stage still requests source evidence that was not fulfilled within the bounded read budget: ${requestedReads.join(", ")}`;
  }
  return (output.requestedFileSearches?.length ?? 0) > 0
    ? "The stage still requests bounded source search evidence and has not consumed it within the read budget."
    : null;
}
