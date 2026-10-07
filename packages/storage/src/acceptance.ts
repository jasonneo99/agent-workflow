import type pg from "pg";
import { createHash } from "node:crypto";
import { structuredAcceptanceDecision } from "../../model-providers/src/quality.js";
import type { AcceptanceGate, StructuredAcceptanceContract } from "../../model-providers/src/types.js";

export function acceptanceGate(stage: string): AcceptanceGate | null {
  if (/^(implement(?:ation)?|fix|backend|frontend|database)(?:$|[-_])/u.test(stage)) return "implementation";
  if (/^(verify|test|validation)(?:$|[-_])/u.test(stage)) return "verification";
  if (/^(package|deliver|release)(?:$|[-_])/u.test(stage)) return "packaging";
  if (/^(supervise|supervision|supervisor)(?:$|[-_])/u.test(stage)) return "supervision";
  return null;
}

/** JSONB reorders object keys; identities must not depend on serialization order. */
export function acceptanceDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
      : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Provider output can supply evidence, never rewrite runtime-owned requirements. */
export function acceptanceProposal(
  frozen: StructuredAcceptanceContract, proposal: StructuredAcceptanceContract
): StructuredAcceptanceContract | null {
  try {
    const identity = (contract: StructuredAcceptanceContract) => ({
      version: contract.version, contractId: contract.contractId, projectId: contract.projectId, sourcePaths: contract.sourcePaths,
      originRunId: contract.originRunId, taskHash: contract.taskHash, subjectHash: contract.subjectHash,
      deliverables: contract.deliverables.map(({ id, description, requiredGates, advisory, severity }) => ({ id, description, requiredGates, advisory, severity }))
    });
    return acceptanceDigest(identity(frozen)) === acceptanceDigest(identity(proposal)) ? proposal : null;
  } catch { return null; }
}

export type StoredAcceptanceDecision = { mode: "legacy" | "structured"; reason: string | null; findings?: Array<{ deliverableId: string; severity: "warn" | "info"; message: string }> };

/** Enrollment is allowed only before execution, never as a completion shortcut. */
export async function enrollAcceptanceContract(
  client: Pick<pg.Client, "query">, runId: string, contract: StructuredAcceptanceContract
): Promise<void> {
  const result = await client.query<{ projectId: string; task: string; metadata: Record<string, unknown>; started: boolean }>(
    `select r.project_id::text as "projectId", r.task, r.evaluation_metadata as metadata,
      exists(select 1 from workflow_tasks t where t.run_id=r.id and (t.attempts>0 or t.status<>'queued')) as started
     from workflow_runs r where r.id=$1 for update`, [runId]
  );
  const row = result.rows[0];
  if (!row || row.started) throw new Error("Acceptance enrollment requires an unstarted run.");
  if (row.metadata?.acceptanceContract) {
    if (acceptanceDigest(row.metadata.acceptanceContract) === acceptanceDigest(contract)) return;
    throw new Error("Acceptance contract is immutable after enrollment.");
  }
  const gates = ["implementation", "verification", "packaging", "supervision"] as const;
  if (contract.version !== 1 || !contract.contractId || !contract.subjectHash
    || (contract.sourcePaths !== undefined && (!Array.isArray(contract.sourcePaths) || !contract.sourcePaths.length || contract.sourcePaths.length > 1000
      || new Set(contract.sourcePaths).size !== contract.sourcePaths.length
      || contract.sourcePaths.some((file) => typeof file !== "string" || !file || file.startsWith("/") || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === ".."))))
    || contract.projectId !== row.projectId || contract.originRunId !== runId || contract.taskHash !== acceptanceDigest(row.task)
    || !contract.deliverables.length || new Set(contract.deliverables.map((item) => item.id)).size !== contract.deliverables.length
    || contract.deliverables.some((item) => !item.id || !item.description || item.status !== "pending"
      || !item.requiredGates.length || item.requiredGates.some((gate) => !gates.includes(gate))
      || !["block", "warn", "info"].includes(item.severity ?? "block")
      || ((item.severity === "warn" || item.severity === "info") && item.advisory !== true)
      || Object.keys(item.receipts).length > 0 || item.gaps.length > 0)
    || gates.some((gate) => !contract.deliverables.some((item) => item.requiredGates.includes(gate)))) {
    throw new Error("Acceptance enrollment requires complete pending requirements and matching run identity.");
  }
  await client.query(`update workflow_runs set evaluation_metadata=jsonb_set(coalesce(evaluation_metadata,'{}'::jsonb),'{acceptanceContract}',$2::jsonb) where id=$1`,
    [runId, JSON.stringify(contract)]);
}

export async function acceptancePreflight(
  client: Pick<pg.Client, "query">, runId: string, artifact: Record<string, unknown>
) {
  const decisions = [];
  for (const gate of ["implementation", "verification", "packaging", "supervision"] as const) {
    decisions.push({ gate, ...await storedAcceptanceDecision(client, runId, gate, artifact) });
  }
  return { accepted: decisions.every((item) => item.mode === "structured" && item.reason === null), decisions };
}

/** Use the caller's transaction so completion and evidence validation share a snapshot. */
export async function storedAcceptanceDecision(
  client: Pick<pg.Client, "query">, runId: string, gate: AcceptanceGate,
  artifact: Record<string, unknown>
): Promise<StoredAcceptanceDecision> {
  return resolveStoredAcceptance(client, runId, gate, artifact);
}

/** Historical recovery only; never used for current completion or preflight. */
export async function historicalCheckpointAcceptanceDecision(
  client: Pick<pg.Client, "query">, runId: string, taskId: string, gate: AcceptanceGate,
  artifact: Record<string, unknown>
): Promise<StoredAcceptanceDecision> {
  const receipt = await client.query<{ metadata: Record<string, unknown>; completedAt: string }>(
    `select metadata, created_at::text as "completedAt" from action_receipts
     where run_id=$1 and target=$2 and action_type='stage_completed' order by created_at desc limit 1`, [runId, taskId]);
  const attested = receipt.rows[0];
  if (!attested?.completedAt || !Number.isFinite(Date.parse(attested.completedAt))
    || acceptanceDigest(attested.metadata) !== acceptanceDigest(artifact)) {
    return { mode: "structured", reason: "Historical completion attestation is invalid." };
  }
  return resolveStoredAcceptance(client, runId, gate, artifact, attested.completedAt);
}

async function resolveStoredAcceptance(
  client: Pick<pg.Client, "query">, runId: string, gate: AcceptanceGate,
  artifact: Record<string, unknown>, completedAt?: string
): Promise<StoredAcceptanceDecision> {
  const run = await client.query<{ projectId: string; task: string; metadata: Record<string, unknown> }>(
    `select project_id::text as "projectId", task, evaluation_metadata as metadata from workflow_runs where id=$1`, [runId]
  );
  const row = run.rows[0];
  if (!row) return { mode: "structured", reason: "Acceptance run identity is unavailable." };
  const frozen = row.metadata?.acceptanceContract as StructuredAcceptanceContract | undefined;
  if (!frozen) return { mode: "legacy", reason: artifact.acceptanceContract ? "Provider cannot enroll or replace a runtime acceptance contract." : null };
  const proposed = acceptanceProposal(frozen, artifact.acceptanceContract as StructuredAcceptanceContract);
  if (!proposed || frozen.projectId !== row.projectId || frozen.taskHash !== acceptanceDigest(row.task)) {
    return { mode: "structured", reason: "Acceptance contract identity or required deliverables changed." };
  }
  // Until ancestry is explicitly attested, cross-run evidence fails closed.
  if (frozen.originRunId !== runId) return { mode: "structured", reason: "Acceptance ancestry requires explicit revalidation." };
  const decision = await structuredAcceptanceDecision(proposed, gate, async (reference) => {
    const result = await client.query<{
      runId: string; taskId: string; stageId: string; projectId: string;
      kind: string; content: Record<string, unknown>; observedAt: Date;
    }>(`select a.run_id::text as "runId", a.task_id::text as "taskId", t.stage_id as "stageId",
          r.project_id::text as "projectId", a.kind, a.content, a.created_at as "observedAt"
        from artifacts a join workflow_runs r on r.id=a.run_id
        join workflow_tasks t on t.id=a.task_id and t.run_id=a.run_id
        where a.uri=$1 and a.run_id=$2 and ($3::timestamptz is null or a.created_at <= $3::timestamptz)`, [reference.artifactUri, runId, completedAt ?? null]);
    const evidence = result.rows[0];
    if (!evidence || evidence.kind !== "command_output") return null;
    // Accept only executed command results, not provider-authored stage outputs.
    const content = evidence.content;
    if (typeof content.commandLine !== "string" || !content.commandLine.trim()) return null;
    if (typeof content.commandLine === "string") {
      const latest = await client.query<{ uri: string }>(
        `select uri from artifacts where run_id=$1 and kind='command_output'
         and content->>'commandLine'=$2
         and ($3::timestamptz is null or created_at <= $3::timestamptz)
         order by created_at desc, id desc limit 1`,
        [runId, content.commandLine, completedAt ?? null]
      );
      // A newer execution supersedes the older receipt, including a newer failure.
      if (latest.rows[0]?.uri !== reference.artifactUri) return null;
    }
    if (frozen.sourcePaths && (acceptanceDigest(content.sourcePaths ?? null) !== acceptanceDigest(frozen.sourcePaths)
      || content.sourceBefore !== frozen.subjectHash || content.sourceAfter !== frozen.subjectHash)) return null;
    return {
      ...reference, kind: "command_output", runId: evidence.runId, taskId: evidence.taskId, stageId: evidence.stageId,
      projectId: evidence.projectId, contentHash: acceptanceDigest(content),
      observedAt: new Date(evidence.observedAt).toISOString(),
      subjectHash: String(content.subjectHash ?? ""),
      passed: content.exitCode === 0 && content.timedOut === false
    };
  });
  return { mode: "structured", ...decision };
}
