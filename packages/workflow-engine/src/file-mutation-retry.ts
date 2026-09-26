import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { executeAllowedFileRead } from "../../local-tools/src/file-reader.js";
import type { StateDelta } from "../../model-providers/src/state-deltas.js";
import { recordRunAction } from "../../storage/src/postgres.js";

type StageRead = { path: string; content: string; truncated: boolean; sha256?: string; error?: string };

export function isRecoverableFileMutationFailure(message: string): boolean {
  return /(?:context mismatch|removal mismatch|hunk count mismatch|hunk starts outside|invalid hunk header|unsupported hunk line|no unified-diff hunks|malformed patch|preimage|expected hash|hash mismatch|stale)/iu.test(message);
}

export function fileWriteRejectionRecovered(actions: unknown[], rejected: unknown): boolean {
  if (!rejected || typeof rejected !== "object" || !("path" in rejected)) return false;
  const path = String(rejected.path);
  return actions.some((candidate) => Boolean(
    candidate && typeof candidate === "object" && "type" in candidate &&
    candidate.type === "file_write" && "path" in candidate && String(candidate.path) === path
  ));
}

export async function prepareRejectedPatchRetry(input: {
  path: string;
  cwd: string;
  project: ProjectConfig;
  rejectionMessage: string;
  rejectionArtifactUri: string;
  runId: string;
  retriesRemaining: number;
  stageId: string;
  agentId: string;
  taskId: string;
  reads: StageRead[];
  deltas: StateDelta[];
}): Promise<void> {
  const refreshed = await executeAllowedFileRead({ relativePath: input.path, cwd: input.cwd, project: input.project });
  const read = { path: input.path, content: refreshed.content, truncated: refreshed.truncated, sha256: refreshed.sha256 };
  const prior = input.reads.findIndex((item) => item.path === input.path);
  if (prior >= 0) input.reads[prior] = read;
  else input.reads.push(read);
  input.deltas.push({
    op: "update",
    key: `file:${input.path}`,
    fact: `The previous patch was rejected without changing the file (${input.rejectionMessage}). Regenerate only this patch against the refreshed file content.`,
    provenance: { stageId: input.stageId, agentId: input.agentId, actionType: "file_write", taskId: input.taskId, artifactUri: input.rejectionArtifactUri },
    assertedAt: new Date().toISOString()
  });
  await recordRunAction({
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.agentId,
    actionType: "file_write_retry_scheduled",
    target: input.path,
    summary: `Refreshing ${input.path} and retrying the surgical patch in this stage (${input.retriesRemaining} retries remain).`,
    artifactKind: "file_write_retry",
    artifactContent: { rejectionArtifactUri: input.rejectionArtifactUri, rejectionMessage: input.rejectionMessage, retriesRemaining: input.retriesRemaining }
  });
}
