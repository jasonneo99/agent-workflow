import type pg from "pg";
import { withClient } from "./client.js";
import {
  chainReceipt,
  RECEIPT_CHAIN_GENESIS,
  verifyReceiptChain
} from "../../workflow-engine/src/receipt-chain.js";

/**
 * Direct (Dev mode) sessions.
 *
 * Dev mode is a Cursor-like direct path: one user message = one bounded
 * agent turn, with no workflow run, no queue claim/lease, and no
 * plan/package promotion. Sessions and turns live in their own tables so
 * queue semantics (`workflow_runs` / `workflow_tasks`) stay untouched.
 *
 * Audit parity: every turn and diff decision writes a hash-chained receipt
 * into `dev_session_receipts` using the same `chainReceipt` construction as
 * `appendActionReceipt`. The shared writer itself cannot be reused because
 * it requires a `workflow_runs` row (and creating one would pollute queue
 * semantics), so the chain logic is mirrored here, scoped to the session.
 */

export const devSessionSchemaSql = `
  CREATE TABLE IF NOT EXISTS dev_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_root_uri text NOT NULL,
    project_id text NOT NULL DEFAULT '',
    provider text NOT NULL DEFAULT 'mock',
    model text,
    title text NOT NULL DEFAULT '',
    policy_profile text NOT NULL DEFAULT 'trusted-personal',
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dev_sessions_status_check CHECK (status IN ('active', 'closed'))
  );
  CREATE INDEX IF NOT EXISTS dev_sessions_project_created_idx
  ON dev_sessions(project_root_uri, created_at DESC);
  CREATE TABLE IF NOT EXISTS dev_session_turns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    provider text,
    model text,
    usage jsonb NOT NULL DEFAULT '{}',
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dev_session_turns_role_check CHECK (role IN ('user', 'assistant')),
    CONSTRAINT dev_session_turns_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed', 'awaiting_approval', 'blocked'))
  );
  CREATE INDEX IF NOT EXISTS dev_session_turns_session_created_idx
  ON dev_session_turns(session_id, created_at);
  CREATE TABLE IF NOT EXISTS dev_session_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dev_session_id uuid NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
    turn_id uuid REFERENCES dev_session_turns(id) ON DELETE SET NULL,
    agent_id text NOT NULL,
    action_type text NOT NULL,
    target text NOT NULL,
    summary text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}',
    prev_hash text,
    receipt_hash text,
    metadata_serialization_version integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS dev_session_receipts_session_created_idx
  ON dev_session_receipts(dev_session_id, created_at);
  CREATE TABLE IF NOT EXISTS dev_session_diffs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
    turn_id uuid REFERENCES dev_session_turns(id) ON DELETE SET NULL,
    path text NOT NULL,
    original_hash text,
    proposed_content text NOT NULL DEFAULT '',
    diff_text text NOT NULL DEFAULT '',
    payload_hash text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'proposed',
    decided_by text,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dev_session_diffs_status_check CHECK (status IN ('proposed', 'accepted', 'rejected')),
    UNIQUE(session_id, turn_id, path)
  );
  CREATE INDEX IF NOT EXISTS dev_session_diffs_session_idx
  ON dev_session_diffs(session_id, created_at);
`;

export interface DevSession {
  id: string;
  projectRootUri: string;
  projectId: string;
  provider: string;
  model: string | null;
  title: string;
  policyProfile: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface DevSessionTurn {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval" | "blocked";
  provider: string | null;
  model: string | null;
  usage: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevSessionDiff {
  id: string;
  sessionId: string;
  turnId: string | null;
  path: string;
  originalHash: string | null;
  proposedContent: string;
  diffText: string;
  payloadHash: string;
  status: "proposed" | "accepted" | "rejected";
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevSessionReceipt {
  id: string;
  devSessionId: string;
  turnId: string | null;
  agentId: string;
  actionType: string;
  target: string;
  summary: string;
  metadata: Record<string, unknown>;
  prevHash: string | null;
  receiptHash: string | null;
  createdAt: string;
}

function sessionFromRow(row: Record<string, unknown>): DevSession {
  return {
    id: row.id as string,
    projectRootUri: row.project_root_uri as string,
    projectId: row.project_id as string,
    provider: row.provider as string,
    model: (row.model as string | null) ?? null,
    title: row.title as string,
    policyProfile: row.policy_profile as string,
    status: row.status as DevSession["status"],
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString()
  };
}

function turnFromRow(row: Record<string, unknown>): DevSessionTurn {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as DevSessionTurn["role"],
    content: row.content as string,
    status: row.status as DevSessionTurn["status"],
    provider: (row.provider as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    usage: (row.usage as Record<string, unknown>) ?? {},
    error: (row.error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString()
  };
}

function diffFromRow(row: Record<string, unknown>): DevSessionDiff {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    turnId: (row.turn_id as string | null) ?? null,
    path: row.path as string,
    originalHash: (row.original_hash as string | null) ?? null,
    proposedContent: row.proposed_content as string,
    diffText: row.diff_text as string,
    payloadHash: row.payload_hash as string,
    status: row.status as DevSessionDiff["status"],
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: row.decided_at ? (row.decided_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString()
  };
}

export async function createDevSession(input: {
  projectRootUri: string;
  projectId?: string;
  provider?: string;
  model?: string | null;
  title?: string;
}): Promise<DevSession> {
  return withClient(async (client) => {
    const result = await client.query(
      `insert into dev_sessions (project_root_uri, project_id, provider, model, title)
       values ($1, $2, $3, $4, $5) returning *`,
      [
        input.projectRootUri,
        input.projectId ?? "",
        input.provider ?? "mock",
        input.model ?? null,
        input.title ?? ""
      ]
    );
    return sessionFromRow(result.rows[0] as Record<string, unknown>);
  });
}

export async function getDevSession(sessionId: string): Promise<DevSession | null> {
  return withClient(async (client) => {
    const result = await client.query(`select * from dev_sessions where id = $1::uuid`, [sessionId]);
    if (!result.rows.length) return null;
    return sessionFromRow(result.rows[0] as Record<string, unknown>);
  });
}

export async function listDevSessions(input: { projectRootUri?: string; limit?: number } = {}): Promise<DevSession[]> {
  return withClient(async (client) => {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const result = input.projectRootUri
      ? await client.query(`select * from dev_sessions where project_root_uri = $1 order by created_at desc limit $2`, [
          input.projectRootUri,
          limit
        ])
      : await client.query(`select * from dev_sessions order by created_at desc limit $1`, [limit]);
    return result.rows.map((row) => sessionFromRow(row as Record<string, unknown>));
  });
}

export async function addDevSessionTurn(input: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  status?: DevSessionTurn["status"];
  provider?: string | null;
  model?: string | null;
}): Promise<DevSessionTurn> {
  return withClient(async (client) => {
    const result = await client.query(
      `insert into dev_session_turns (session_id, role, content, status, provider, model)
       values ($1::uuid, $2, $3, $4, $5, $6) returning *`,
      [
        input.sessionId,
        input.role,
        input.content,
        input.status ?? "pending",
        input.provider ?? null,
        input.model ?? null
      ]
    );
    return turnFromRow(result.rows[0] as Record<string, unknown>);
  });
}

export async function updateDevSessionTurn(
  turnId: string,
  patch: { content?: string; status?: DevSessionTurn["status"]; usage?: Record<string, unknown>; error?: string | null }
): Promise<DevSessionTurn | null> {
  return withClient(async (client) => {
    const result = await client.query(
      `update dev_session_turns
       set content = coalesce($2, content),
           status = coalesce($3, status),
           usage = coalesce($4::jsonb, usage),
           error = $5,
           updated_at = now()
       where id = $1::uuid returning *`,
      [
        turnId,
        patch.content ?? null,
        patch.status ?? null,
        patch.usage ? JSON.stringify(patch.usage) : null,
        patch.error ?? null
      ]
    );
    if (!result.rows.length) return null;
    return turnFromRow(result.rows[0] as Record<string, unknown>);
  });
}

export async function listDevSessionTurns(sessionId: string): Promise<DevSessionTurn[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `select * from dev_session_turns where session_id = $1::uuid order by created_at asc, id asc`,
      [sessionId]
    );
    return result.rows.map((row) => turnFromRow(row as Record<string, unknown>));
  });
}

/**
 * Hash-chained receipt for a dev session, mirroring `appendActionReceipt`:
 * same `chainReceipt` construction, same strictly-increasing timestamps,
 * scoped to the session instead of a workflow run. The parent session row
 * is locked so concurrent writers serialize on the chain tip.
 */
export async function appendDevSessionReceipt(input: {
  sessionId: string;
  turnId?: string | null;
  agentId: string;
  actionType: string;
  target: string;
  summary: string;
  metadata: Record<string, unknown>;
}): Promise<{ receiptHash: string }> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const session = await client.query(`select id from dev_sessions where id = $1::uuid for update`, [
        input.sessionId
      ]);
      if (!session.rows.length) throw new Error("Cannot append a receipt without its dev session");
      const previous = await client.query<{ receipt_hash: string | null; created_at: Date }>(
        `select receipt_hash, created_at from dev_session_receipts
         where dev_session_id = $1::uuid order by created_at desc limit 1`,
        [input.sessionId]
      );
      const latest = previous.rows[0];
      const tip = await client.query<{ receipt_hash: string }>(
        `select r.receipt_hash from dev_session_receipts r where r.dev_session_id = $1::uuid
         and r.receipt_hash is not null and not exists (
           select 1 from dev_session_receipts child where child.dev_session_id = r.dev_session_id
           and child.prev_hash = r.receipt_hash
         ) order by r.created_at desc limit 1`,
        [input.sessionId]
      );
      const createdAt = new Date(Math.max(Date.now(), latest ? latest.created_at.getTime() + 1 : 0)).toISOString();
      const metadata = JSON.stringify(input.metadata);
      const receipt = chainReceipt(tip.rows[0]?.receipt_hash ?? RECEIPT_CHAIN_GENESIS, {
        runId: input.sessionId,
        agentId: input.agentId,
        actionType: input.actionType,
        target: input.target,
        summary: input.summary,
        metadata,
        createdAt,
        metadataSerializationVersion: 2
      });
      await client.query(
        `insert into dev_session_receipts
           (dev_session_id, turn_id, agent_id, action_type, target, summary, metadata, prev_hash, receipt_hash, created_at, metadata_serialization_version)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz, 2)`,
        [
          input.sessionId,
          input.turnId ?? null,
          input.agentId,
          input.actionType,
          input.target,
          input.summary,
          metadata,
          receipt.prevHash,
          receipt.receiptHash,
          createdAt
        ]
      );
      await client.query("commit");
      return { receiptHash: receipt.receiptHash };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function listDevSessionReceipts(sessionId: string): Promise<DevSessionReceipt[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `select * from dev_session_receipts where dev_session_id = $1::uuid order by created_at asc`,
      [sessionId]
    );
    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: record.id as string,
        devSessionId: record.dev_session_id as string,
        turnId: (record.turn_id as string | null) ?? null,
        agentId: record.agent_id as string,
        actionType: record.action_type as string,
        target: record.target as string,
        summary: record.summary as string,
        metadata: (record.metadata as Record<string, unknown>) ?? {},
        prevHash: (record.prev_hash as string | null) ?? null,
        receiptHash: (record.receipt_hash as string | null) ?? null,
        createdAt: (record.created_at as Date).toISOString()
      };
    });
  });
}

export async function verifyDevSessionReceiptChain(
  sessionId: string
): Promise<{ valid: boolean; checked: number; brokenAt?: number; reason?: string }> {
  return withClient(async (client) => {
    const result = await client.query(
      `select agent_id, action_type, target, summary, metadata::text as metadata, created_at, prev_hash, receipt_hash, metadata_serialization_version
       from dev_session_receipts where dev_session_id = $1::uuid order by created_at asc`,
      [sessionId]
    );
    if (result.rows.some((row) => (row as { receipt_hash: string | null }).receipt_hash && (row as { prev_hash: string | null }).prev_hash == null)) {
      return { valid: false, checked: 0, reason: "hashed receipt is missing prev_hash" };
    }
    const receipts = result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        runId: sessionId,
        agentId: record.agent_id as string,
        actionType: record.action_type as string,
        target: record.target as string,
        summary: record.summary as string,
        metadata: record.metadata as string,
        metadataSerializationVersion: (record.metadata_serialization_version as number | null) ?? undefined,
        createdAt: (record.created_at as Date).toISOString(),
        prevHash: (record.prev_hash as string | null) ?? "GENESIS",
        receiptHash: (record.receipt_hash as string | null) ?? ""
      };
    });
    const unchained = receipts.filter((receipt) => !receipt.receiptHash).length;
    if (!receipts.length || unchained) {
      return {
        valid: false,
        checked: 0,
        reason: !receipts.length ? "no receipts to verify" : `${unchained} unchained receipts; full coverage unavailable`
      };
    }
    const successors = new Map<string, typeof receipts>();
    for (const receipt of receipts) {
      const next = successors.get(receipt.prevHash) ?? [];
      next.push(receipt);
      successors.set(receipt.prevHash, next);
    }
    const ordered: typeof receipts = [];
    let tip = "GENESIS";
    const seen = new Set<string>();
    while (successors.has(tip)) {
      const next = successors.get(tip)!;
      if (next.length !== 1 || seen.has(next[0].receiptHash)) {
        return { valid: false, checked: 0, reason: "receipt chain fork or cycle" };
      }
      ordered.push(next[0]);
      seen.add(next[0].receiptHash);
      tip = next[0].receiptHash;
    }
    if (ordered.length !== receipts.length) {
      return { valid: false, checked: 0, reason: "disconnected receipt chain" };
    }
    return verifyReceiptChain(ordered);
  });
}

export async function upsertDevSessionDiff(input: {
  sessionId: string;
  turnId: string | null;
  path: string;
  originalHash: string | null;
  proposedContent: string;
  diffText: string;
  payloadHash: string;
}): Promise<DevSessionDiff> {
  return withClient(async (client) => {
    const result = await client.query(
      `insert into dev_session_diffs (session_id, turn_id, path, original_hash, proposed_content, diff_text, payload_hash)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
       on conflict (session_id, turn_id, path) do update
       set original_hash = excluded.original_hash,
           proposed_content = excluded.proposed_content,
           diff_text = excluded.diff_text,
           payload_hash = excluded.payload_hash,
           status = 'proposed',
           decided_by = null,
           decided_at = null,
           updated_at = now()
       returning *`,
      [
        input.sessionId,
        input.turnId,
        input.path,
        input.originalHash,
        input.proposedContent,
        input.diffText,
        input.payloadHash
      ]
    );
    return diffFromRow(result.rows[0] as Record<string, unknown>);
  });
}

export async function listDevSessionDiffs(sessionId: string): Promise<DevSessionDiff[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `select * from dev_session_diffs where session_id = $1::uuid order by created_at asc, path asc`,
      [sessionId]
    );
    return result.rows.map((row) => diffFromRow(row as Record<string, unknown>));
  });
}

export async function getDevSessionDiff(diffId: string): Promise<DevSessionDiff | null> {
  return withClient(async (client) => {
    const result = await client.query(`select * from dev_session_diffs where id = $1::uuid`, [diffId]);
    if (!result.rows.length) return null;
    return diffFromRow(result.rows[0] as Record<string, unknown>);
  });
}

export async function setDevSessionDiffDecision(input: {
  diffId: string;
  status: "accepted" | "rejected";
  decidedBy: string;
}): Promise<DevSessionDiff | null> {
  return withClient(async (client) => {
    const result = await client.query(
      `update dev_session_diffs
       set status = $2, decided_by = $3, decided_at = now(), updated_at = now()
       where id = $1::uuid and status = 'proposed' returning *`,
      [input.diffId, input.status, input.decidedBy]
    );
    if (!result.rows.length) return null;
    return diffFromRow(result.rows[0] as Record<string, unknown>);
  });
}
