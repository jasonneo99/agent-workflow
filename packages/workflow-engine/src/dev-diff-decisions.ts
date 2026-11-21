import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { selectApprovedFileMutation } from "../../local-tools/src/approved-file-mutation.js";
import { applyDiffHunk, invertUnifiedDiff, parseDiffHunks, type DiffHunk } from "../../local-tools/src/file-diff.js";
import { executeAllowedFileMutation } from "../../local-tools/src/file-patcher.js";
import {
  appendDevSessionReceipt,
  getDevSessionDiff,
  listDevSessionDiffHunks,
  setDevSessionDiffDecision,
  setDevSessionDiffHunkDecision,
  syncDevSessionDiffHunks,
  type DevSessionDiff,
  type DevSessionDiffHunk
} from "../../storage/src/dev-sessions.js";
import { DEV_MODE_AGENT_ID, sha256Hex } from "./direct-turn.js";

/**
 * Per-file / per-hunk Accept and Reject for Dev mode diffs.
 *
 * Agent edits are proposed, never applied directly. Accepting verifies the
 * preimage before writing: the current file must equal the original content
 * with already-accepted hunks applied (reconstructed from the proposed
 * content via the reversed diff, so no original copy is stored), each
 * accepted hunk's context lines must match at its adjusted position, and
 * the write goes through `selectApprovedFileMutation` (the Accept click is
 * the durable approval binding the exact payload) plus
 * `executeAllowedFileMutation`. Rejecting a hunk leaves the file untouched.
 * Every decision writes a hash-chained dev receipt.
 */

export function reconstructOriginalContent(proposedContent: string, diffText: string): string {
  if (!diffText) return proposedContent;
  return invertUnifiedDiff(proposedContent, diffText);
}

export interface DevDiffDecisionInput {
  diffId: string;
  decision: "accept" | "reject";
  hunkIndex?: number;
  decidedBy: string;
  projectDir: string;
  project: ProjectConfig;
}

export interface DevDiffDecisionResult {
  diff: DevSessionDiff;
  hunks: DevSessionDiffHunk[];
  appliedHunks: number[];
  rejectedHunks: number[];
  newHash: string | null;
}

async function refreshParentDiffStatus(diffId: string): Promise<DevSessionDiff | null> {
  const hunks = await listDevSessionDiffHunks(diffId);
  if (!hunks.length || hunks.some((hunk) => hunk.status === "proposed")) return null;
  if (hunks.every((hunk) => hunk.status === "accepted")) {
    return setDevSessionDiffDecision({ diffId, status: "accepted", decidedBy: "system" });
  }
  if (hunks.every((hunk) => hunk.status === "rejected")) {
    return setDevSessionDiffDecision({ diffId, status: "rejected", decidedBy: "system" });
  }
  // Mixed accept/reject: the parent stays proposed; hunk rows carry the truth.
  return null;
}

async function receipt(input: {
  sessionId: string;
  turnId: string | null;
  actionType: string;
  target: string;
  summary: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await appendDevSessionReceipt({
    sessionId: input.sessionId,
    turnId: input.turnId,
    agentId: DEV_MODE_AGENT_ID,
    actionType: input.actionType,
    target: input.target,
    summary: input.summary,
    metadata: input.metadata
  });
}

export async function decideDevSessionDiff(input: DevDiffDecisionInput): Promise<DevDiffDecisionResult> {
  const diff = await getDevSessionDiff(input.diffId);
  if (!diff) throw new Error(`Unknown dev diff: ${input.diffId}`);
  let hunks = await listDevSessionDiffHunks(diff.id);
  if (!hunks.length && diff.diffText) {
    hunks = await syncDevSessionDiffHunks(
      diff.id,
      parseDiffHunks(diff.diffText).map((hunk) => hunk.header)
    );
  }
  const parsedHunks = parseDiffHunks(diff.diffText);
  if (hunks.length !== parsedHunks.length) {
    throw new Error(`Diff ${diff.id.slice(0, 8)} has ${hunks.length} tracked hunks but ${parsedHunks.length} in its diff text.`);
  }
  const targets =
    input.hunkIndex === undefined
      ? hunks.filter((hunk) => hunk.status === "proposed")
      : hunks.filter((hunk) => hunk.hunkIndex === input.hunkIndex);
  if (input.hunkIndex !== undefined && targets.length === 0) {
    throw new Error(`Unknown hunk ${input.hunkIndex} for diff ${diff.id.slice(0, 8)}.`);
  }
  if (!targets.length) throw new Error(`Diff ${diff.path} has no proposed hunks left to decide.`);
  if (targets.some((hunk) => hunk.status !== "proposed")) {
    throw new Error(`Diff ${diff.path} hunk ${targets.find((hunk) => hunk.status !== "proposed")?.hunkIndex} was already decided.`);
  }

  if (input.decision === "reject") {
    const rejectedHunks: number[] = [];
    for (const hunk of targets) {
      const decided = await setDevSessionDiffHunkDecision({
        diffId: diff.id,
        hunkIndex: hunk.hunkIndex,
        status: "rejected",
        decidedBy: input.decidedBy
      });
      if (!decided) throw new Error(`Diff ${diff.path} hunk ${hunk.hunkIndex} was already decided.`);
      rejectedHunks.push(hunk.hunkIndex);
    }
    await receipt({
      sessionId: diff.sessionId,
      turnId: diff.turnId,
      actionType: "dev_diff_rejected",
      target: diff.path,
      summary: `Rejected ${rejectedHunks.length} hunk(s) of ${diff.path}; the file was not changed.`,
      metadata: { diffId: diff.id, hunks: rejectedHunks, decidedBy: input.decidedBy }
    });
    const refreshed = await refreshParentDiffStatus(diff.id);
    const updated = refreshed ?? diff;
    return {
      diff: updated,
      hunks: await listDevSessionDiffHunks(diff.id),
      appliedHunks: [],
      rejectedHunks,
      newHash: null
    };
  }

  // Accept: verify the preimage, then apply the selected hunks.
  const absolutePath = path.resolve(input.projectDir, diff.path);
  const current = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const originalContent = reconstructOriginalContent(diff.proposedContent, diff.diffText);
  let expectedCurrent = originalContent;
  let acceptedOffset = 0;
  for (const hunk of hunks.filter((item) => item.status === "accepted").sort((a, b) => a.hunkIndex - b.hunkIndex)) {
    const parsed = parsedHunks[hunk.hunkIndex];
    expectedCurrent = applyDiffHunk(expectedCurrent, { ...parsed, oldStart: parsed.oldStart + acceptedOffset });
    acceptedOffset += parsed.newCount - parsed.oldCount;
  }
  if ((current ?? "") !== expectedCurrent) {
    const currentHash = current === null ? null : sha256Hex(current);
    throw new Error(
      `Stale preimage: ${diff.path} changed since the proposal was prepared` +
        (diff.originalHash && currentHash ? ` (expected ${diff.originalHash.slice(0, 12)}, found ${currentHash.slice(0, 12)})` : "") +
        ". Re-read the file and ask for a fresh proposal."
    );
  }

  // Apply selected hunks last-first so earlier positions stay valid; each
  // selected hunk is shifted by the deltas of already-accepted earlier hunks.
  const acceptedEarlier = hunks.filter((item) => item.status === "accepted");
  let newContent = current ?? "";
  const appliedHunks: number[] = [];
  for (const hunk of [...targets].sort((a, b) => b.hunkIndex - a.hunkIndex)) {
    const parsed = parsedHunks[hunk.hunkIndex];
    const offset = acceptedEarlier
      .filter((item) => item.hunkIndex < hunk.hunkIndex)
      .reduce((sum, item) => {
        const earlier = parsedHunks[item.hunkIndex];
        return sum + (earlier.newCount - earlier.oldCount);
      }, 0);
    const adjusted: DiffHunk = { ...parsed, oldStart: parsed.oldStart + offset };
    newContent = applyDiffHunk(newContent, adjusted);
    appliedHunks.push(hunk.hunkIndex);
  }
  appliedHunks.sort((a, b) => a - b);

  // The Accept click is the durable approval: bind the exact new content
  // through approved-file-mutation before writing.
  const newHash = sha256Hex(newContent);
  const approval = { mode: "replace", payloadHash: newHash, expectedHash: diff.originalHash ?? undefined };
  // Replace writes carry no expectedHash: normalizeRequestedFileMutation
  // rejects a replace request that carries one (only patch requests do).
  // The preimage was already verified above via the stale check.
  const writes = [{ path: diff.path, content: newContent }];
  const mutation = selectApprovedFileMutation(diff.path, approval, writes);
  await executeAllowedFileMutation({
    request: mutation.request,
    payload: mutation.payload,
    isPatch: mutation.isPatch,
    expectedHash: mutation.expectedHash,
    cwd: input.projectDir,
    project: input.project
  });
  const written = await fs.readFile(absolutePath, "utf8");
  if (sha256Hex(written) !== newHash) {
    throw new Error(`Write verification failed for ${diff.path}: the file does not match the accepted content.`);
  }

  for (const hunkIndex of appliedHunks) {
    const decided = await setDevSessionDiffHunkDecision({
      diffId: diff.id,
      hunkIndex,
      status: "accepted",
      decidedBy: input.decidedBy
    });
    if (!decided) throw new Error(`Diff ${diff.path} hunk ${hunkIndex} was already decided.`);
  }
  await receipt({
    sessionId: diff.sessionId,
    turnId: diff.turnId,
    actionType: "dev_diff_accepted",
    target: diff.path,
    summary: `Accepted ${appliedHunks.length} hunk(s) of ${diff.path} (${appliedHunks.join(", ")}).`,
    metadata: { diffId: diff.id, hunks: appliedHunks, newHash, decidedBy: input.decidedBy }
  });
  const refreshed = await refreshParentDiffStatus(diff.id);
  return {
    diff: refreshed ?? diff,
    hunks: await listDevSessionDiffHunks(diff.id),
    appliedHunks,
    rejectedHunks: [],
    newHash
  };
}
