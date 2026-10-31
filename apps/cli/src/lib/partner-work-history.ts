import { withClient } from '../../../../packages/storage/src/client.js';
import type { PoolClient } from 'pg';
import { sanitizeAssistantText } from '../../../../packages/conversation-contract/src/index.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const actions = ['stage_started','stage_completed','stage_blocked','stage_failed','stage_cancelled','execution_progress','file_read','file_read_rejected','file_write','file_write_rejected','local_command','local_command_reused','local_command_rejected','action_approval_requested','action_approval_approved','action_approval_rejected','action_approval_executing','action_approval_executed','action_approval_failed','queue_partner_decision','queue_partner_operator_command'];
export type WorkStep = { id: string; at: string; agent: string; stage: string; kind: string; state: string; title: string; detail: string; cursor: string; url: string };
export type WorkHistoryRow = { id: string; runId: string; at: string; agent: string; action: string; target: string; summary: string; metadata: Record<string, any> };
export type WorkHistorySnapshot = { run: { id: string; projectId: string; title: string; status: string }; rows: WorkHistoryRow[]; tasks: Array<{ id: string; agent: string; stage: string; status: string; worker: string | null; lease: string | null; startedAt: string | null }> };
export interface WorkHistoryAdapter { snapshot(input: { projectId: string; runId: string; after?: string; before?: string; limit: number }): Promise<WorkHistorySnapshot | null> }
export function parseWorkCursor(value?: string): [string, string] | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 120) throw Error('Invalid work-history cursor.');
  const parts = value.split('|');
  if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(parts[0]) || !Number.isFinite(Date.parse(parts[0])) || !uuid.test(parts[1])) throw Error('Invalid work-history cursor.');
  return parts as [string, string];
}
function scrub(value: unknown, max = 500): string {
  return sanitizeAssistantText(String(value ?? ''), max)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/((?:--)?(?:api[_-]?key|password|secret|token|authorization|credential)\s*[:=]?\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]');
}
function fileName(value: string): string {
  if (!value || value.startsWith('/') || value.includes('..') || /(?:^|\/)\.env(?:\.|\/|$)|(?:^|\/)(?:\.git|node_modules)(?:\/|$)|\.(?:pem|key|p12)$/i.test(value)) return 'a project file';
  return scrub(value, 240);
}
/** A projection of actual receipt metadata; no output bodies, source contents or permission tokens. */
export function projectWorkStep(row: WorkHistoryRow, runId: string): WorkStep | null {
  if (row.runId !== runId || !uuid.test(row.id) || !actions.includes(row.action) || !Number.isFinite(Date.parse(row.at))) return null;
  const m = row.metadata ?? {}, action = row.action;
  let kind = 'agent', state = 'recorded', title = 'Agent update', detail = scrub(row.summary);
  if (action === 'execution_progress') {
    kind = m.operation === 'command' ? 'command' : m.operation === 'file_write' ? 'write' : 'agent'; state = 'started';
    title = kind === 'command' ? `Running ${scrub(row.target, 240)}` : kind === 'write' ? `Editing ${fileName(row.target)}` : 'Agent started working';
    detail = kind === 'agent' ? 'Waiting for the next recorded agent action.' : '';
  } else if (action.startsWith('file_read')) { kind = 'read'; state = action.endsWith('rejected') ? 'failed' : 'completed'; title = `${state === 'failed' ? 'Could not read' : 'Read'} ${fileName(row.target)}`; detail = state === 'failed' ? detail : ''; }
  else if (action.startsWith('file_write')) { kind = 'write'; state = action.endsWith('rejected') ? 'failed' : 'completed'; title = `${state === 'failed' ? 'Could not update' : 'Updated'} ${fileName(row.target)}`; detail = state === 'failed' ? detail : ''; }
  else if (action.startsWith('local_command')) {
    kind = 'command'; state = action.endsWith('rejected') || m.timedOut === true || (typeof m.exitCode === 'number' && m.exitCode !== 0) ? 'failed' : typeof m.exitCode === 'number' && m.exitCode === 0 ? 'completed' : 'recorded';
    title = action.endsWith('reused') ? `Reused recorded result: ${scrub(row.target, 220)}` : `${state === 'completed' ? 'Finished' : state === 'failed' ? 'Check failed:' : 'Recorded command:'} ${scrub(row.target, 220)}`;
    detail = m.timedOut === true ? 'Command timed out.' : typeof m.exitCode === 'number' ? `Exit code ${m.exitCode}.` : 'Open the run for its recorded result.';
  } else if (action.startsWith('action_approval_')) {
    kind = 'approval'; const suffix = action.slice('action_approval_'.length); state = suffix === 'requested' ? 'waiting' : suffix === 'failed' || suffix === 'rejected' ? 'failed' : suffix === 'executing' ? 'started' : 'recorded';
    title = ({ requested: 'Approval requested', approved: 'Approval recorded', rejected: 'Request declined', executing: 'Approved action started', executed: 'Action marked executed', failed: 'Approved action failed' } as Record<string, string>)[suffix] ?? 'Decision recorded';
    detail = suffix === 'executed' ? 'This recorded action state is separate from acceptance of the work.' : scrub(row.target, 260);
  } else if (action.startsWith('stage_')) {
    const suffix = action.slice(6); state = suffix === 'started' ? 'started' : suffix === 'completed' ? 'completed' : suffix === 'blocked' ? 'waiting' : suffix === 'cancelled' ? 'stopped' : 'failed';
    kind = suffix === 'blocked' || suffix === 'failed' ? 'blocker' : 'stage';
    title = ({ started: 'Stage started', completed: 'Stage completed', blocked: 'Agent needs input', failed: 'Stage failed', cancelled: 'Stage stopped' } as Record<string, string>)[suffix] ?? 'Stage update';
  } else if (action === 'queue_partner_decision') { kind = 'decision'; title = 'Partner recorded the next step'; }
  return { id: `${runId}:${row.id}`, at: row.at, agent: scrub(row.agent, 100), stage: scrub(m.stage ?? m.requestedByStageId ?? '', 100), kind, state, title, detail, cursor: `${row.at}|${row.id}`, url: `/run?id=${runId}` };
}

export async function readPartnerWorkSnapshot(client: Pick<PoolClient, 'query'>, input: Parameters<WorkHistoryAdapter['snapshot']>[0]): Promise<WorkHistorySnapshot | null> {
  const after = parseWorkCursor(input.after), before = parseWorkCursor(input.before), cursor = after ?? before;
  await client.query('begin isolation level repeatable read read only');
  try {
    const run = (await client.query(`select id::text,project_id::text as "projectId",left(task,300) title,status from workflow_runs where id=$1::uuid and project_id=$2::uuid`, [input.runId, input.projectId])).rows[0];
    if (!run) return null;
    // Only explicit summary fields cross the boundary. Artifact contents, command
    // output, approval payloads and file previews are never loaded for this view.
    const rows = (await client.query(`select a.id::text,a.run_id::text as "runId",to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,
      case when a.action_type='stage_started' then coalesce(t.agent_id,a.agent_id) else a.agent_id end agent,a.action_type action,left(a.target,500) target,left(a.summary,700) summary,
      jsonb_build_object('operation',a.metadata->'operation','exitCode',a.metadata->'exitCode','timedOut',a.metadata->'timedOut','stage',coalesce(a.metadata->'requestedByStageId',a.metadata->'stageId',to_jsonb(t.stage_id))) metadata
      from action_receipts a join workflow_runs r on r.id=a.run_id
      left join workflow_tasks t on t.run_id=a.run_id and t.id::text=coalesce(a.metadata->>'requestedByTaskId',a.metadata->>'taskId',case when a.action_type like 'stage_%' then a.target end)
      where r.project_id=$1::uuid and a.run_id=$2::uuid and a.action_type=any($3::text[])
      ${cursor ? `and (a.created_at,a.id) ${after ? '>' : '<'} ($4::timestamptz,$5::uuid)` : ''}
      order by a.created_at ${after ? 'asc' : 'desc'},a.id ${after ? 'asc' : 'desc'} limit $${cursor ? 6 : 4}`, cursor ? [input.projectId, input.runId, actions, cursor[0], cursor[1], input.limit + 1] : [input.projectId, input.runId, actions, input.limit + 1])).rows;
    const tasks = (await client.query(`select id::text,agent_id agent,stage_id stage,status,worker_id worker,lease_expires_at::text lease,started_at::text as "startedAt" from workflow_tasks where run_id=$1::uuid and status in ('running','leased') order by started_at desc,id limit 5`, [input.runId])).rows;
    return { run, rows, tasks };
  } finally { await client.query('rollback'); }
}
const storage: WorkHistoryAdapter = { snapshot: input => withClient(client => readPartnerWorkSnapshot(client, input)) };

export async function buildPartnerWorkHistory(input: { projectId: string; runId: string; after?: string; before?: string }, adapter: WorkHistoryAdapter = storage, now = Date.now()) {
  if (!uuid.test(input.projectId) || !uuid.test(input.runId) || input.after && input.before) throw Error('An exact project and run scope is required.');
  parseWorkCursor(input.after); parseWorkCursor(input.before);
  const limit = 80, data = await adapter.snapshot({ ...input, limit });
  if (!data || data.run.id !== input.runId || data.run.projectId !== input.projectId) return null;
  const page = data.rows.filter(row => row.runId === input.runId).slice(0, limit), more = data.rows.length > limit;
  const steps = page.map(row => projectWorkStep(row, input.runId)).filter((step): step is WorkStep => Boolean(step));
  steps.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const active = data.tasks.filter(task => ['running','leased'].includes(data.run.status) && ['running','leased'].includes(task.status) && Boolean(task.worker) && Date.parse(task.lease ?? '') > now).slice(0, 5).map(task => ({ id: task.id, agent: scrub(task.agent, 100), stage: scrub(task.stage, 100), startedAt: task.startedAt, leaseExpiresAt: task.lease }));
  return { version: 1, authority: 'evidence-only', scope: { projectId: input.projectId, runId: input.runId }, observedAt: new Date(now).toISOString(), run: { id: data.run.id, title: scrub(data.run.title, 250), status: data.run.status }, steps, active,
    after: steps.at(-1)?.cursor ?? input.after ?? null, before: steps[0]?.cursor ?? input.before ?? null, hasMore: Boolean(input.after && more), hasOlder: !input.after && more };
}
