import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { withClient } from "../../storage/src/client.js";

export interface OwnershipReceipt {
  runId: string;
  taskId: string;
  stageId: string;
  kind: string;
  uri: string;
  status: string | null;
  operation: string | null;
  content: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
}

export function ownershipPath(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const relative = value.trim().replace(/\\/gu, "/");
  if (!relative || relative.endsWith("/") || path.posix.isAbsolute(relative)
    || /^[A-Za-z]:/u.test(relative) || relative.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(relative);
  return normalized === "." ? null : normalized;
}

export const normalizeOwnershipPath = ownershipPath;

/** Rows are newest first. Ownership evidence never authorizes a mutation. */
export async function receiptOwnership(input: {
  runId: string;
  rows: OwnershipReceipt[];
  currentHash: (relative: string) => Promise<string | null>;
}): Promise<Set<string>> {
  const seen = new Set<string>();
  const owned = new Set<string>();
  for (const row of input.rows) {
    if (row.runId !== input.runId || row.kind !== "file_write") continue;
    const relative = ownershipPath(row.content?.relativePath);
    if (!relative || seen.has(relative)) continue;
    // Invalid latest evidence must not resurrect an older receipt.
    seen.add(relative);
    const nextHash = row.content.nextHash;
    if (!row.taskId || !row.stageId || !row.uri
      || row.content.requestedByTaskId !== row.taskId
      || row.content.requestedByStageId !== row.stageId
      || row.status !== "completed" || row.operation !== "file_write"
      || row.receipt?.artifactUri !== row.uri
      || ownershipPath(row.receipt?.path) !== relative
      || typeof nextHash !== "string" || !/^[a-f0-9]{64}$/u.test(nextHash)
      || row.receipt?.nextHash !== nextHash) continue;
    try {
      if (await input.currentHash(relative) === nextHash) owned.add(relative);
    } catch {
      // Missing or unreadable files cannot establish current ownership.
    }
  }
  return owned;
}

export async function reconstructRunWriteFootprint(runId: string, cwd: string): Promise<Set<string>> {
  const rows = await withClient(async (client) => (await client.query<OwnershipReceipt>(`
    select a.run_id::text as "runId", wt.id::text as "taskId",
      wt.stage_id as "stageId", a.kind, a.uri, a.content,
      s.status, s.operation, s.receipt
    from artifacts a
    join workflow_tasks wt on wt.id=a.task_id and wt.run_id=a.run_id
    left join side_effect_receipts s on s.project_id=a.run_id::text
      and s.idempotency_key=a.content->>'idempotencyKey'
    where a.run_id=$1::uuid and a.kind='file_write'
    order by a.created_at desc, a.id desc
  `, [runId])).rows);
  if (!rows.length) return new Set<string>();
  const root = await realpath(cwd);
  return receiptOwnership({ runId, rows, currentHash: async (relative) => {
    const absolute = await realpath(path.resolve(root, relative));
    if (!absolute.startsWith(`${root}${path.sep}`)) return null;
    return createHash("sha256").update(await readFile(absolute)).digest("hex");
  } });
}
