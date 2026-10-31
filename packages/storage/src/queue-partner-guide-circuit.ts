import { createHash, randomUUID } from 'node:crypto';
import { withClient } from './client.js';
import { appendActionReceipt } from './receipt-writer.js';

export type QueuePartnerGuideCircuitEventKind = 'failure' | 'opened' | 'probe-claimed' | 'closed';

export interface QueuePartnerGuideCircuitEvent {
  schemaVersion: 1;
  projectId: string;
  sourceRunId: string;
  taskClass: string;
  generation: number;
  previousGeneration: number;
  previousEventDigest: string | null;
  eventDigest: string;
  kind: QueuePartnerGuideCircuitEventKind;
  failures: number;
  reason: string | null;
  openedAt: string | null;
  retryAt: string | null;
  probeToken: string | null;
  probeExpiresAt: string | null;
  recordedAt: string;
  authority: 'advisory-circuit-only';
}

export interface QueuePartnerGuideCircuitState {
  generation: number;
  eventDigest: string | null;
  failures: number;
  open: boolean;
  reason: string | null;
  openedAt: string | null;
  retryAt: string | null;
  probeToken: string | null;
  probeExpiresAt: string | null;
  quarantined: number;
  authority: 'advisory-circuit-only';
}

export interface QueuePartnerGuideCircuitCheckpoint {
  schemaVersion: 1;
  projectId: string;
  sourceRunId: string;
  taskClass: string;
  prefixCount: number;
  prefixRootDigest: string;
  previousCheckpointDigest: string | null;
  terminalGeneration: number;
  terminalEventDigest: string;
  currentState: Omit<QueuePartnerGuideCircuitState, 'quarantined'>;
  retainedSuffixStartGeneration: number;
  recordedAt: string;
  authority: 'audit-checkpoint-only';
  checkpointDigest: string;
}

type CircuitRow = { metadata: unknown; receiptAuthentic?: boolean };
export type QueuePartnerGuideCircuitDiagnosticRow = CircuitRow & { runId?: string; workerId?: string | null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventCore = (value: Omit<QueuePartnerGuideCircuitEvent, 'eventDigest'>) => ({
  schemaVersion: value.schemaVersion,
  projectId: value.projectId,
  sourceRunId: value.sourceRunId,
  taskClass: value.taskClass,
  generation: value.generation,
  previousGeneration: value.previousGeneration,
  previousEventDigest: value.previousEventDigest,
  kind: value.kind,
  failures: value.failures,
  reason: value.reason,
  openedAt: value.openedAt,
  retryAt: value.retryAt,
  probeToken: value.probeToken,
  probeExpiresAt: value.probeExpiresAt,
  recordedAt: value.recordedAt,
  authority: value.authority,
});
const checkpointCore = (value: Omit<QueuePartnerGuideCircuitCheckpoint, 'checkpointDigest'>) => ({
  schemaVersion: value.schemaVersion,
  projectId: value.projectId,
  sourceRunId: value.sourceRunId,
  taskClass: value.taskClass,
  prefixCount: value.prefixCount,
  prefixRootDigest: value.prefixRootDigest,
  previousCheckpointDigest: value.previousCheckpointDigest,
  terminalGeneration: value.terminalGeneration,
  terminalEventDigest: value.terminalEventDigest,
  currentState: {
    generation: value.currentState.generation,
    eventDigest: value.currentState.eventDigest,
    failures: value.currentState.failures,
    open: value.currentState.open,
    reason: value.currentState.reason,
    openedAt: value.currentState.openedAt,
    retryAt: value.currentState.retryAt,
    probeToken: value.currentState.probeToken,
    probeExpiresAt: value.currentState.probeExpiresAt,
    authority: value.currentState.authority,
  },
  retainedSuffixStartGeneration: value.retainedSuffixStartGeneration,
  recordedAt: value.recordedAt,
  authority: value.authority,
});
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function buildQueuePartnerGuideCircuitCheckpoint(input: {
  projectId: string;
  taskClass: string;
  prefix: readonly QueuePartnerGuideCircuitEvent[];
  prior?: QueuePartnerGuideCircuitCheckpoint | null;
  recordedAt?: string;
}): QueuePartnerGuideCircuitCheckpoint {
  if (!input.prefix.length) throw new Error('Guide circuit checkpoint requires a non-empty verified prefix');
  const first = input.prefix[0]!;
  const terminal = input.prefix.at(-1)!;
  const expectedGeneration = (input.prior?.terminalGeneration ?? 0) + 1;
  if (first.generation !== expectedGeneration || first.previousEventDigest !== (input.prior?.terminalEventDigest ?? null)) {
    throw new Error('Guide circuit checkpoint prefix is not contiguous');
  }
  const parsed = parseQueuePartnerGuideCircuitHistory(
    input.prefix.map(metadata => ({ metadata, receiptAuthentic: true })),
    input.projectId,
    input.taskClass,
    input.prior ?? null,
  );
  if (parsed.quarantined || parsed.latest?.eventDigest !== terminal.eventDigest) {
    throw new Error('Guide circuit checkpoint prefix is not verified');
  }
  const state = queuePartnerGuideCircuitState(parsed);
  const core = checkpointCore({
    schemaVersion: 1,
    projectId: input.projectId,
    sourceRunId: terminal.sourceRunId,
    taskClass: input.taskClass,
    prefixCount: (input.prior?.prefixCount ?? 0) + input.prefix.length,
    prefixRootDigest: digest({
      previousPrefixRootDigest: input.prior?.prefixRootDigest ?? 'GENESIS',
      eventDigests: input.prefix.map(event => event.eventDigest),
    }),
    previousCheckpointDigest: input.prior?.checkpointDigest ?? null,
    terminalGeneration: terminal.generation,
    terminalEventDigest: terminal.eventDigest,
    currentState: {
      generation: state.generation,
      eventDigest: state.eventDigest,
      failures: state.failures,
      open: state.open,
      reason: state.reason,
      openedAt: state.openedAt,
      retryAt: state.retryAt,
      probeToken: state.probeToken,
      probeExpiresAt: state.probeExpiresAt,
      authority: state.authority,
    },
    retainedSuffixStartGeneration: terminal.generation + 1,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    authority: 'audit-checkpoint-only',
  });
  return { ...core, checkpointDigest: digest(core) };
}

export function parseQueuePartnerGuideCircuitCheckpoint(row: CircuitRow | null | undefined, projectId: string, taskClass: string) {
  const value = (typeof row?.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })() : row?.metadata) as QueuePartnerGuideCircuitCheckpoint | null;
  let reasonCode: string | null = null;
  if (!value || value.schemaVersion !== 1) reasonCode = 'malformed-checkpoint';
  else if (row?.receiptAuthentic === false) reasonCode = 'inauthentic-checkpoint-receipt';
  else if (value.projectId !== projectId || value.taskClass !== taskClass) reasonCode = 'unbound-checkpoint';
  else if (!Number.isSafeInteger(value.prefixCount) || value.prefixCount < 1 || value.terminalGeneration !== value.prefixCount || value.retainedSuffixStartGeneration !== value.terminalGeneration + 1) reasonCode = 'invalid-checkpoint-range';
  else if (!validDigest(value.prefixRootDigest) || !validDigest(value.terminalEventDigest) || (value.previousCheckpointDigest !== null && !validDigest(value.previousCheckpointDigest))) reasonCode = 'invalid-checkpoint-binding';
  else if (value.currentState?.generation !== value.terminalGeneration || value.currentState?.eventDigest !== value.terminalEventDigest || value.currentState?.authority !== 'advisory-circuit-only') reasonCode = 'invalid-checkpoint-state';
  else if (!Number.isSafeInteger(value.currentState.failures) || value.currentState.failures < 0 || typeof value.currentState.open !== 'boolean') reasonCode = 'invalid-checkpoint-state';
  else if (value.currentState.open && (!value.currentState.openedAt || !value.currentState.retryAt)) reasonCode = 'invalid-checkpoint-state';
  else if (!value.currentState.open && (value.currentState.openedAt !== null || value.currentState.retryAt !== null || value.currentState.probeToken !== null || value.currentState.probeExpiresAt !== null)) reasonCode = 'invalid-checkpoint-state';
  else {
    const { checkpointDigest, ...core } = value;
    if (!validDigest(checkpointDigest) || digest(checkpointCore(core)) !== checkpointDigest) reasonCode = 'invalid-checkpoint-digest';
  }
  return { checkpoint: reasonCode ? null : value, reasonCode, authority: 'audit-checkpoint-only' as const };
}

export function buildQueuePartnerGuideCircuitEvent(input: {
  projectId: string;
  sourceRunId: string;
  taskClass: string;
  prior?: QueuePartnerGuideCircuitEvent | null;
  kind: QueuePartnerGuideCircuitEventKind;
  failures: number;
  reason?: string | null;
  openedAt?: string | null;
  retryAt?: string | null;
  probeToken?: string | null;
  probeExpiresAt?: string | null;
  recordedAt?: string;
}): QueuePartnerGuideCircuitEvent {
  const core = eventCore({
    schemaVersion: 1,
    projectId: input.projectId,
    sourceRunId: input.sourceRunId,
    taskClass: input.taskClass,
    generation: (input.prior?.generation ?? 0) + 1,
    previousGeneration: input.prior?.generation ?? 0,
    previousEventDigest: input.prior?.eventDigest ?? null,
    kind: input.kind,
    failures: Math.max(0, Math.floor(input.failures)),
    reason: input.reason ?? null,
    openedAt: input.openedAt ?? null,
    retryAt: input.retryAt ?? null,
    probeToken: input.probeToken ?? null,
    probeExpiresAt: input.probeExpiresAt ?? null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    authority: 'advisory-circuit-only',
  });
  return { ...core, eventDigest: digest(core) };
}

export function parseQueuePartnerGuideCircuitHistory(rows: readonly CircuitRow[], projectId: string, taskClass: string, checkpoint: QueuePartnerGuideCircuitCheckpoint | null = null) {
  const history: Array<QueuePartnerGuideCircuitEvent & { status: 'valid' | 'quarantined'; reasonCode: string | null }> = [];
  let prior: QueuePartnerGuideCircuitEvent | null = checkpoint ? {
    schemaVersion: 1,
    projectId,
    sourceRunId: checkpoint.sourceRunId,
    taskClass,
    generation: checkpoint.terminalGeneration,
    previousGeneration: Math.max(0, checkpoint.terminalGeneration - 1),
    previousEventDigest: null,
    eventDigest: checkpoint.terminalEventDigest,
    kind: checkpoint.currentState.probeToken ? 'probe-claimed' : checkpoint.currentState.open ? 'opened' : checkpoint.currentState.failures > 0 ? 'failure' : 'closed',
    failures: checkpoint.currentState.failures,
    reason: checkpoint.currentState.reason,
    openedAt: checkpoint.currentState.openedAt,
    retryAt: checkpoint.currentState.retryAt,
    probeToken: checkpoint.currentState.probeToken,
    probeExpiresAt: checkpoint.currentState.probeExpiresAt,
    recordedAt: checkpoint.recordedAt,
    authority: 'advisory-circuit-only',
  } : null;
  let chainBroken = false;
  for (const row of rows.slice(-100)) {
    const value = (typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })() : row.metadata) as QueuePartnerGuideCircuitEvent | null;
    let reasonCode: string | null = null;
    if (chainBroken) reasonCode = 'quarantined-predecessor';
    else if (!value || value.schemaVersion !== 1) reasonCode = 'malformed';
    else if (row.receiptAuthentic === false) reasonCode = 'inauthentic-receipt';
    else if (value.projectId !== projectId || value.taskClass !== taskClass) reasonCode = 'unbound';
    else if (value.previousGeneration !== (prior?.generation ?? 0) || value.generation !== (prior?.generation ?? 0) + 1 || value.previousEventDigest !== (prior?.eventDigest ?? null)) reasonCode = 'stale-generation';
    else {
      const { eventDigest, ...core } = value;
      if (!/^[a-f0-9]{64}$/u.test(eventDigest) || digest(eventCore(core)) !== eventDigest) reasonCode = 'invalid-event-digest';
      else if (value.kind === 'opened' && (!value.openedAt || !value.retryAt || value.failures < 1)) reasonCode = 'invalid-open-event';
      else if (value.kind === 'probe-claimed' && (!value.probeToken || !value.probeExpiresAt || !value.openedAt || !value.retryAt)) reasonCode = 'invalid-probe-event';
      else if (value.kind === 'closed' && (value.failures !== 0 || value.openedAt !== null || value.retryAt !== null || value.probeToken !== null)) reasonCode = 'invalid-close-event';
    }
    if (reasonCode) {
      chainBroken = true;
      if (value) history.push({ ...value, status: 'quarantined', reasonCode });
      continue;
    }
    prior = value!;
    history.push({ ...value!, status: 'valid', reasonCode: null });
  }
  const latest = prior;
  return {
    latest,
    history: [...history].reverse(),
    quarantined: history.filter(item => item.status === 'quarantined').length,
  };
}

export function queuePartnerGuideCircuitState(parsed: ReturnType<typeof parseQueuePartnerGuideCircuitHistory>, now = Date.now()): QueuePartnerGuideCircuitState {
  const latest = parsed.latest;
  const open = latest?.kind === 'opened' || latest?.kind === 'probe-claimed';
  const probeActive = latest?.kind === 'probe-claimed' && Date.parse(latest.probeExpiresAt ?? '') > now;
  return {
    generation: latest?.generation ?? 0,
    eventDigest: latest?.eventDigest ?? null,
    failures: latest?.failures ?? 0,
    open,
    reason: latest?.reason ?? null,
    openedAt: latest?.openedAt ?? null,
    retryAt: latest?.retryAt ?? null,
    probeToken: probeActive ? latest?.probeToken ?? null : null,
    probeExpiresAt: probeActive ? latest?.probeExpiresAt ?? null : null,
    quarantined: parsed.quarantined,
    authority: 'advisory-circuit-only',
  };
}

export function summarizeQueuePartnerGuideCircuitDiagnostics(rows: readonly QueuePartnerGuideCircuitDiagnosticRow[], projectId: string, now = Date.now()) {
  const groups = new Map<string, QueuePartnerGuideCircuitDiagnosticRow[]>();
  for (const row of rows.slice(-500)) {
    const metadata = typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })() : row.metadata;
    const taskClass = metadata && typeof metadata === 'object' && typeof (metadata as { taskClass?: unknown }).taskClass === 'string' ? (metadata as { taskClass: string }).taskClass.slice(0, 160) : 'unknown';
    groups.set(taskClass, [...(groups.get(taskClass) ?? []), row]);
  }
  return [...groups.entries()].slice(0, 50).map(([taskClass, group]) => {
    const parsed = parseQueuePartnerGuideCircuitHistory(group, projectId, taskClass);
    const state = queuePartnerGuideCircuitState(parsed, now);
    const latest = parsed.latest;
    const retryAt = state.retryAt ? Date.parse(state.retryAt) : 0;
    const probeExpiresAt = state.probeExpiresAt ? Date.parse(state.probeExpiresAt) : 0;
    const status = parsed.quarantined ? 'quarantined' : state.open && probeExpiresAt > now ? 'recovery-probe' : state.open && retryAt > now ? 'cooldown' : state.open ? 'recovery-overdue' : 'healthy';
    const reconciliation = status === 'quarantined' ? 'Review the first quarantined generation and its authentic predecessor; do not reset or restart the chain.'
      : status === 'recovery-overdue' ? 'A bounded recovery probe is eligible; the next fenced worker may claim it without resetting history.'
      : status === 'recovery-probe' ? 'One bounded recovery probe owns this task class; other workers must wait for its receipt or lease expiry.'
      : status === 'cooldown' ? 'Wait for the durable retry time; restarts and other Fleet workers must not retry early.'
      : 'No reconciliation is required.';
    return {
      taskClass,
      status,
      generation: state.generation,
      failures: state.failures,
      reason: state.reason,
      retryAt: state.retryAt,
      probeExpiresAt: state.probeExpiresAt,
      sourceRunId: latest?.sourceRunId ?? group.at(-1)?.runId ?? null,
      affectedWorkers: [...new Set(group.map(row => row.workerId).filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 8),
      quarantined: parsed.quarantined,
      reconciliation,
      authority: 'diagnostic-only' as const,
    };
  }).sort((left, right) => Number(right.status !== 'healthy') - Number(left.status !== 'healthy') || right.generation - left.generation || left.taskClass.localeCompare(right.taskClass));
}

async function loadCircuitRows(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }, projectId: string, taskClass: string, afterGeneration: number, limit = 101): Promise<CircuitRow[]> {
  return (await client.query(`select a.metadata,
    a.receipt_hash is not null and a.receipt_hash ~ '^[a-f0-9]{64}$'
      and (a.prev_hash='GENESIS' or exists(select 1 from action_receipts p where p.run_id=a.run_id and p.receipt_hash=a.prev_hash)) "receiptAuthentic"
    from action_receipts a join workflow_runs r on r.id=a.run_id
    where r.project_id=$1 and a.action_type='guide_circuit_transition' and a.metadata->>'taskClass'=$2
      and case when a.metadata->>'generation' ~ '^[0-9]+$' then (a.metadata->>'generation')::integer else -1 end > $3
    order by case when a.metadata->>'generation' ~ '^[0-9]+$' then (a.metadata->>'generation')::integer else -1 end,a.created_at,a.id limit $4`, [projectId, taskClass, afterGeneration, limit])).rows;
}

async function loadCircuitCheckpoint(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }, projectId: string, taskClass: string): Promise<QueuePartnerGuideCircuitCheckpoint | null> {
  const rows = (await client.query(`select a.metadata,
    a.receipt_hash is not null and a.receipt_hash ~ '^[a-f0-9]{64}$'
      and (a.prev_hash='GENESIS' or exists(select 1 from action_receipts p where p.run_id=a.run_id and p.receipt_hash=a.prev_hash)) "receiptAuthentic"
    from action_receipts a join workflow_runs r on r.id=a.run_id
    where r.project_id=$1 and a.action_type='guide_circuit_checkpoint' and a.metadata->>'taskClass'=$2
    order by a.created_at desc,a.id desc limit 2`, [projectId, taskClass])).rows.reverse() as CircuitRow[];
  let prior: QueuePartnerGuideCircuitCheckpoint | null = null;
  if (rows.length === 1) {
    const only = parseQueuePartnerGuideCircuitCheckpoint(rows[0], projectId, taskClass);
    if (only.checkpoint?.previousCheckpointDigest) throw new Error('Guide circuit checkpoint predecessor is missing');
  }
  for (const row of rows) {
    const parsed = parseQueuePartnerGuideCircuitCheckpoint(row, projectId, taskClass);
    if (!parsed.checkpoint) throw new Error(`Guide circuit checkpoint is invalid: ${parsed.reasonCode}`);
    if (prior && parsed.checkpoint.previousCheckpointDigest !== prior.checkpointDigest) throw new Error('Guide circuit checkpoint chain is stale');
    prior = parsed.checkpoint;
  }
  return prior;
}

async function circuitProject(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }, runId: string): Promise<string> {
  const projectId = String((await client.query('select project_id::text "projectId" from workflow_runs where id=$1 for update', [runId])).rows[0]?.projectId ?? '');
  if (!projectId) throw new Error('Guide circuit source run is unbound');
  return projectId;
}

async function appendCircuitEvent(client: any, event: QueuePartnerGuideCircuitEvent): Promise<void> {
  await appendActionReceipt(client, {
    runId: event.sourceRunId,
    agentId: 'workflow-guide',
    actionType: 'guide_circuit_transition',
    target: `guide-circuit:${event.taskClass}`,
    summary: `Guide circuit ${event.kind} at generation ${event.generation}; advisory circuit only.`,
    metadata: JSON.stringify(event),
  });
}

async function appendCircuitCheckpoint(client: any, checkpoint: QueuePartnerGuideCircuitCheckpoint): Promise<void> {
  await appendActionReceipt(client, {
    runId: checkpoint.sourceRunId,
    agentId: 'workflow-guide',
    actionType: 'guide_circuit_checkpoint',
    target: `guide-circuit:${checkpoint.taskClass}`,
    summary: `Checkpointed ${checkpoint.prefixCount} Guide circuit transitions through generation ${checkpoint.terminalGeneration}; original receipts retained, no circuit authority granted.`,
    metadata: JSON.stringify(checkpoint),
  });
}

async function loadOperationalCircuitHistory(client: any, projectId: string, taskClass: string) {
  let checkpoint = await loadCircuitCheckpoint(client, projectId, taskClass);
  for (let pass = 0; pass < 64; pass += 1) {
    const rows = await loadCircuitRows(client, projectId, taskClass, checkpoint?.terminalGeneration ?? 0);
    if (rows.length <= 100) {
      const parsed = parseQueuePartnerGuideCircuitHistory(rows, projectId, taskClass, checkpoint);
      if (parsed.quarantined) throw new Error('Guide circuit history is stale, unauthentic or unbound');
      return parsed;
    }
    const verified = parseQueuePartnerGuideCircuitHistory(rows.slice(0, 80), projectId, taskClass, checkpoint);
    if (verified.quarantined || !verified.latest) {
      const first = verified.history.slice().reverse().find(item => item.status === 'quarantined');
      throw new Error(`Guide circuit checkpoint prefix is stale, unauthentic or unbound${first ? ` at generation ${first.generation}: ${first.reasonCode}` : ''}`);
    }
    checkpoint = buildQueuePartnerGuideCircuitCheckpoint({
      projectId,
      taskClass,
      prefix: verified.history.slice().reverse().map(({ status: _status, reasonCode: _reasonCode, ...event }) => event),
      prior: checkpoint,
    });
    await appendCircuitCheckpoint(client, checkpoint);
  }
  throw new Error('Guide circuit history exceeds checkpoint catch-up bound');
}

export async function reserveQueuePartnerGuideCircuitAttempt(input: {
  runId: string;
  taskClass: string;
  cooldownMs: number;
  probeLeaseMs?: number;
  now?: Date;
}) {
  return withClient(async client => {
    await client.query('begin');
    try {
      const projectId = await circuitProject(client, input.runId);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${projectId}:guide-circuit:${input.taskClass}`]);
      const parsed = await loadOperationalCircuitHistory(client, projectId, input.taskClass);
      const now = input.now ?? new Date();
      const state = queuePartnerGuideCircuitState(parsed, now.getTime());
      const retryAt = state.retryAt ? Date.parse(state.retryAt) : 0;
      const probeExpiresAt = state.probeExpiresAt ? Date.parse(state.probeExpiresAt) : 0;
      if (state.open && retryAt > now.getTime()) {
        await client.query('commit');
        return { allowed: false as const, reason: 'durable-circuit-open', projectId, state, generation: state.generation, probeToken: null };
      }
      if (state.open && probeExpiresAt > now.getTime()) {
        await client.query('commit');
        return { allowed: false as const, reason: 'durable-probe-already-claimed', projectId, state, generation: state.generation, probeToken: null };
      }
      if (state.open) {
        const token = randomUUID();
        const prior = parsed.latest;
        const event = buildQueuePartnerGuideCircuitEvent({
          projectId,
          sourceRunId: input.runId,
          taskClass: input.taskClass,
          prior,
          kind: 'probe-claimed',
          failures: Math.max(1, state.failures),
          reason: state.reason,
          openedAt: state.openedAt,
          retryAt: state.retryAt,
          probeToken: token,
          probeExpiresAt: new Date(now.getTime() + Math.min(Math.max(input.probeLeaseMs ?? 30_000, 1_000), 60_000)).toISOString(),
          recordedAt: now.toISOString(),
        });
        await appendCircuitEvent(client, event);
        await client.query('commit');
        return { allowed: true as const, reason: 'bounded-recovery-probe', projectId, state: queuePartnerGuideCircuitState({ ...parsed, latest: event }, now.getTime()), generation: event.generation, probeToken: token };
      }
      await client.query('commit');
      return { allowed: true as const, reason: 'durable-circuit-closed', projectId, state, generation: state.generation, probeToken: null };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

export async function recordQueuePartnerGuideCircuitOutcome(input: {
  runId: string;
  taskClass: string;
  expectedGeneration: number;
  probeToken?: string | null;
  outcome: 'success' | 'failure';
  reason?: string | null;
  failureThreshold: number;
  cooldownMs: number;
  now?: Date;
}) {
  return withClient(async client => {
    await client.query('begin');
    try {
      const projectId = await circuitProject(client, input.runId);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${projectId}:guide-circuit:${input.taskClass}`]);
      const parsed = await loadOperationalCircuitHistory(client, projectId, input.taskClass);
      if ((parsed.latest?.generation ?? 0) !== input.expectedGeneration) throw new Error('Stale Guide circuit generation');
      if (parsed.latest?.kind === 'probe-claimed' && parsed.latest.probeToken !== (input.probeToken ?? null)) throw new Error('Stale Guide recovery probe');
      if (parsed.latest?.kind !== 'probe-claimed' && input.probeToken) throw new Error('Unbound Guide recovery probe');
      const now = input.now ?? new Date();
      const prior = parsed.latest;
      if (input.outcome === 'success' && !prior?.failures && prior?.kind !== 'probe-claimed') {
        await client.query('commit');
        return { recorded: false, reason: 'circuit-already-healthy', state: queuePartnerGuideCircuitState(parsed, now.getTime()) };
      }
      const failures = input.outcome === 'success' ? 0 : (prior?.failures ?? 0) + 1;
      const opened = input.outcome === 'failure' && (prior?.kind === 'probe-claimed' || failures >= Math.max(1, input.failureThreshold));
      const event = buildQueuePartnerGuideCircuitEvent({
        projectId,
        sourceRunId: input.runId,
        taskClass: input.taskClass,
        prior,
        kind: input.outcome === 'success' ? 'closed' : opened ? 'opened' : 'failure',
        failures,
        reason: input.outcome === 'failure' ? input.reason ?? 'guide-execution-failed' : null,
        openedAt: opened ? now.toISOString() : null,
        retryAt: opened ? new Date(now.getTime() + input.cooldownMs).toISOString() : null,
        recordedAt: now.toISOString(),
      });
      await appendCircuitEvent(client, event);
      await client.query('commit');
      return { recorded: true, reason: event.kind, state: queuePartnerGuideCircuitState({ ...parsed, latest: event }, now.getTime()) };
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}
