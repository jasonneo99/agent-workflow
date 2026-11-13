import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ConversationEntry, InputLease, SliceCommit, SliceCommitResult, SliceStore, ThreadInput, ThreadInputQueue, ThreadState } from "../../suspend-resume-runtime/src/index.js";
import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";

export const suspendResumeRuntimeSchemaSql = `
  CREATE TABLE IF NOT EXISTS suspend_resume_threads (
    thread_id text PRIMARY KEY,
    run_id uuid REFERENCES workflow_runs(id) ON DELETE CASCADE,
    agent_id text REFERENCES agents(id),
    revision bigint NOT NULL DEFAULT 0,
    state jsonb NOT NULL,
    conversation jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS suspend_resume_threads_run_idx ON suspend_resume_threads(run_id);
  CREATE TABLE IF NOT EXISTS suspend_resume_inputs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id text NOT NULL REFERENCES suspend_resume_threads(thread_id) ON DELETE CASCADE,
    input_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('user_text','tool_result','tool_event','thread_message')),
    payload jsonb NOT NULL,
    source_created_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL DEFAULT now(),
    claim_owner text,
    claim_token uuid,
    claim_expires_at timestamptz,
    acknowledged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(thread_id, input_id)
  );
  CREATE INDEX IF NOT EXISTS suspend_resume_inputs_ready_idx
    ON suspend_resume_inputs(thread_id, id) WHERE acknowledged_at IS NULL;
  CREATE OR REPLACE FUNCTION public.agentflow_enqueue_suspend_resume_approval() RETURNS trigger AS $$
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status IN ('approved','rejected','expired','dismissed')
       AND nullif(NEW.payload->>'runtimeThreadId','') IS NOT NULL
       AND nullif(NEW.payload->>'runtimeToolCallId','') IS NOT NULL
       AND EXISTS (SELECT 1 FROM suspend_resume_threads WHERE thread_id=NEW.payload->>'runtimeThreadId') THEN
      INSERT INTO suspend_resume_inputs(thread_id,input_id,kind,payload,source_created_at)
      VALUES(NEW.payload->>'runtimeThreadId','approval:' || NEW.id::text || ':' || NEW.status,'tool_event',
        jsonb_build_object('originToolCallId',NEW.payload->>'runtimeToolCallId','eventName','approval_' || NEW.status,
          'result',jsonb_build_object('approvalId',NEW.id::text,'status',NEW.status,'decisionNote',NEW.decision_note)),now())
      ON CONFLICT(thread_id,input_id) DO NOTHING;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS action_approval_suspend_resume ON action_approvals;
  CREATE TRIGGER action_approval_suspend_resume AFTER UPDATE OF status ON action_approvals
    FOR EACH ROW EXECUTE FUNCTION public.agentflow_enqueue_suspend_resume_approval();
`;

function initialState(threadId: string, parentThreadId: string | null): ThreadState {
  return { threadId, revision: 0, status: "ready", processedInputIds: [], issuedToolCallIds: [], answeredToolCallIds: [], pendingDispatch: null, parentThreadId, childThreadIds: [] };
}

function boundedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error(`${label} must be a nonempty bounded string.`);
  return normalized;
}

export interface PostgresRuntimeIdentity {
  runId?: string;
  agentId?: string;
}

export class PostgresSliceStore implements SliceStore {
  constructor(private readonly identity: PostgresRuntimeIdentity = {}) {}

  createThread(threadId: string, options: { parentThreadId?: string } = {}): Promise<ThreadState> {
    boundedIdentity(threadId, "Thread ID");
    const state = initialState(threadId, options.parentThreadId ?? null);
    return withClient(async (client) => {
      const result = await client.query<{ state: ThreadState }>(`
        INSERT INTO suspend_resume_threads(thread_id,run_id,agent_id,state)
        VALUES($1,$2::uuid,$3,$4::jsonb)
        ON CONFLICT(thread_id) DO UPDATE SET thread_id=excluded.thread_id
        RETURNING state`, [threadId, this.identity.runId ?? null, this.identity.agentId ?? null, JSON.stringify(state)]);
      return result.rows[0]!.state;
    });
  }

  async loadThread(threadId: string): Promise<ThreadState | null> {
    return withClient(async (client) => (await client.query<{ state: ThreadState }>(`SELECT state FROM suspend_resume_threads WHERE thread_id=$1`, [threadId])).rows[0]?.state ?? null);
  }

  async loadConversation(threadId: string): Promise<readonly ConversationEntry[]> {
    return withClient(async (client) => (await client.query<{ conversation: ConversationEntry[] }>(`SELECT conversation FROM suspend_resume_threads WHERE thread_id=$1`, [threadId])).rows[0]?.conversation ?? []);
  }

  commitSlice(input: SliceCommit): Promise<SliceCommitResult> {
    return withClient(async (client) => {
      await client.query("begin");
      try {
        const row = (await client.query<{ state: ThreadState; conversation: ConversationEntry[]; runId: string | null; agentId: string | null }>(
          `SELECT state,conversation,run_id::text AS "runId",agent_id AS "agentId" FROM suspend_resume_threads WHERE thread_id=$1 FOR UPDATE`, [input.threadId])).rows[0];
        if (!row) throw new Error(`Unknown thread: ${input.threadId}`);
        if (row.state.processedInputIds.includes(input.inputId)) {
          await client.query("commit");
          return { committed: false, reason: "duplicate_input", state: row.state };
        }
        if (row.state.revision !== input.expectedRevision) throw new Error(`Stale thread revision for ${input.threadId}.`);
        const next: ThreadState = { ...row.state, revision: row.state.revision + 1, status: input.status,
          processedInputIds: [...row.state.processedInputIds, input.inputId],
          issuedToolCallIds: [...new Set([...row.state.issuedToolCallIds, ...(input.issuedToolCallIds ?? [])])],
          answeredToolCallIds: [...new Set([...row.state.answeredToolCallIds, ...(input.answeredToolCallIds ?? [])])], pendingDispatch: structuredClone(input.pendingDispatch) };
        await client.query(`UPDATE suspend_resume_threads SET revision=$2,state=$3::jsonb,conversation=$4::jsonb,updated_at=now() WHERE thread_id=$1`,
          [input.threadId, next.revision, JSON.stringify(next), JSON.stringify([...row.conversation, ...input.entries])]);
        if (row.runId && row.agentId) await appendActionReceipt(client, { runId: row.runId, agentId: row.agentId,
          actionType: "suspend_resume_slice_committed", target: input.threadId, summary: "Committed one bounded suspend/resume slice.",
          metadata: JSON.stringify({ inputId: input.inputId, revision: next.revision, status: next.status, entryCount: input.entries.length }) });
        await client.query("commit");
        return { committed: true, state: next };
      } catch (error) { await client.query("rollback"); throw error; }
    });
  }

  markDispatchStarted(threadId: string, expectedRevision: number, toolCallId: string): Promise<ThreadState> {
    return withClient(async (client) => {
      const result = await client.query<{ state: ThreadState }>(`UPDATE suspend_resume_threads SET revision=revision+1,
        state=jsonb_set(jsonb_set(state,'{revision}',to_jsonb(revision+1)),'{pendingDispatch}','null'::jsonb),updated_at=now()
        WHERE thread_id=$1 AND revision=$2 AND state->'pendingDispatch'->>'id'=$3 RETURNING state`, [threadId, expectedRevision, toolCallId]);
      if (!result.rows[0]) throw new Error("Pending dispatch state changed.");
      return result.rows[0].state;
    });
  }

  linkChild(parentThreadId: string, childThreadId: string): Promise<void> {
    return withClient(async (client) => {
      await client.query("begin");
      try {
        const rows = await client.query<{ threadId: string; state: ThreadState }>(`SELECT thread_id AS "threadId",state FROM suspend_resume_threads WHERE thread_id=ANY($1::text[]) FOR UPDATE`, [[parentThreadId, childThreadId]]);
        const parent = rows.rows.find((row) => row.threadId === parentThreadId)?.state;
        const child = rows.rows.find((row) => row.threadId === childThreadId)?.state;
        if (!parent || !child || child.parentThreadId !== parentThreadId) throw new Error("Invalid parent-child link.");
        if (!parent.childThreadIds.includes(childThreadId)) {
          const next = { ...parent, revision: parent.revision + 1, childThreadIds: [...parent.childThreadIds, childThreadId] };
          await client.query(`UPDATE suspend_resume_threads SET revision=$2,state=$3::jsonb,updated_at=now() WHERE thread_id=$1`, [parentThreadId, next.revision, JSON.stringify(next)]);
        }
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
    });
  }
}

export class PostgresInputQueue implements ThreadInputQueue {
  readonly #owner = `suspend-resume:${process.pid}:${randomUUID()}`;
  constructor(private readonly leaseSeconds = 120) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new Error("Lease seconds must be between 30 and 3600.");
  }

  enqueue(message: ThreadInput): Promise<void> {
    boundedIdentity(message.id, "Input ID"); boundedIdentity(message.threadId, "Thread ID");
    return withClient(async (client) => { await client.query(`INSERT INTO suspend_resume_inputs(thread_id,input_id,kind,payload,source_created_at)
      VALUES($1,$2,$3,$4::jsonb,$5::timestamptz) ON CONFLICT(thread_id,input_id) DO NOTHING`, [message.threadId,message.id,message.kind,JSON.stringify(message.payload),message.createdAt]); });
  }

  lease(threadId: string): Promise<InputLease | null> {
    return withClient(async (client) => {
      const claimed = (await client.query<{ id: string; inputId: string; kind: ThreadInput["kind"]; payload: unknown; createdAt: string; token: string }>(`
        WITH candidate AS (SELECT id FROM suspend_resume_inputs WHERE thread_id=$1 AND acknowledged_at IS NULL
          AND (claim_expires_at IS NULL OR claim_expires_at<=now()) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE suspend_resume_inputs i SET claim_owner=$2,claim_token=gen_random_uuid(),claim_expires_at=now()+($3::int*interval '1 second')
        FROM candidate WHERE i.id=candidate.id RETURNING i.id::text,i.input_id AS "inputId",i.kind,i.payload,i.source_created_at::text AS "createdAt",i.claim_token::text AS token`,
        [threadId,this.#owner,this.leaseSeconds])).rows[0];
      if (!claimed) return null;
      let settled = false;
      const settle = async (ack: boolean): Promise<void> => {
        if (settled) return;
        const changed = await withClient(async (settlement) => (await settlement.query(`UPDATE suspend_resume_inputs SET
          acknowledged_at=CASE WHEN $4 THEN now() ELSE acknowledged_at END,claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL
          WHERE id=$1::bigint AND thread_id=$2 AND claim_owner=$3 AND claim_token=$5::uuid AND claim_expires_at>now()`,
          [claimed.id,threadId,this.#owner,ack,claimed.token])).rowCount === 1);
        if (!changed) throw new Error("Suspend/resume input lease was lost.");
        settled = true;
      };
      return { message: { id: claimed.inputId, threadId, kind: claimed.kind, payload: claimed.payload, createdAt: claimed.createdAt }, ack: () => settle(true), nack: () => settle(false) };
    });
  }

  depth(threadId: string): Promise<number> {
    return withClient(async (client) => (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM suspend_resume_inputs WHERE thread_id=$1 AND acknowledged_at IS NULL`, [threadId])).rows[0]?.count ?? 0);
  }
}

export async function registerBoundExecutorThread(input: { runId: string; taskId: string; agentId: string; toolCallId: string; toolName: string; arguments: unknown }): Promise<string> {
  const threadId = `executor:${input.runId}:${input.taskId}`;
  const store = new PostgresSliceStore({ runId: input.runId, agentId: input.agentId });
  const current = await store.createThread(threadId);
  if (!current.issuedToolCallIds.includes(input.toolCallId)) await store.commitSlice({ threadId,expectedRevision:current.revision,inputId:`dispatch:${input.toolCallId}`,
    entries:[{ id:`tool-call:${input.toolCallId}`,sourceInputId:`dispatch:${input.toolCallId}`,role:"assistant",kind:"tool_call",synthetic:false,toolCall:{id:input.toolCallId,name:input.toolName,arguments:input.arguments} }],
    status:"suspended",pendingDispatch:null,issuedToolCallIds:[input.toolCallId] });
  return threadId;
}

export async function enqueueBoundExecutorResult(input: { threadId: string; toolCallId: string; eventId: string; eventName: string; result: unknown }): Promise<void> {
  await new PostgresInputQueue().enqueue({ id:input.eventId,threadId:input.threadId,kind:"tool_event",payload:{originToolCallId:input.toolCallId,eventName:input.eventName,result:input.result},createdAt:new Date().toISOString() });
}
