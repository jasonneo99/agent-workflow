import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildQueuePartnerGuideCircuitCheckpoint,
  buildQueuePartnerGuideCircuitEvent,
  parseQueuePartnerGuideCircuitCheckpoint,
  parseQueuePartnerGuideCircuitHistory,
  queuePartnerGuideCircuitState,
  summarizeQueuePartnerGuideCircuitDiagnostics,
} from './queue-partner-guide-circuit.js';

function circuitEvents(count: number) {
  const events = [];
  let prior = null;
  for (let generation = 1; generation <= count; generation += 1) {
    const event = buildQueuePartnerGuideCircuitEvent({
      projectId: 'project',
      sourceRunId: `run-${generation}`,
      taskClass: 'repair',
      prior,
      kind: 'failure',
      failures: generation,
      reason: 'timeout',
      recordedAt: new Date(Date.UTC(2026, 9, 29, 0, generation)).toISOString(),
    });
    events.push(event);
    prior = event;
  }
  return events;
}

test('durable Guide circuit history preserves failure, open, probe and close generations', () => {
  const failure = buildQueuePartnerGuideCircuitEvent({ projectId: 'project', sourceRunId: 'run-a', taskClass: 'repair', kind: 'failure', failures: 1, reason: 'timeout', recordedAt: '2026-10-29T00:00:00Z' });
  const opened = buildQueuePartnerGuideCircuitEvent({ projectId: 'project', sourceRunId: 'run-b', taskClass: 'repair', prior: failure, kind: 'opened', failures: 3, reason: 'timeout', openedAt: '2026-10-29T00:01:00Z', retryAt: '2026-10-29T00:06:00Z', recordedAt: '2026-10-29T00:01:00Z' });
  const probe = buildQueuePartnerGuideCircuitEvent({ projectId: 'project', sourceRunId: 'run-c', taskClass: 'repair', prior: opened, kind: 'probe-claimed', failures: 3, reason: 'timeout', openedAt: opened.openedAt, retryAt: opened.retryAt, probeToken: 'probe', probeExpiresAt: '2026-10-29T00:07:00Z', recordedAt: '2026-10-29T00:06:00Z' });
  const closed = buildQueuePartnerGuideCircuitEvent({ projectId: 'project', sourceRunId: 'run-c', taskClass: 'repair', prior: probe, kind: 'closed', failures: 0, recordedAt: '2026-10-29T00:06:10Z' });
  const parsed = parseQueuePartnerGuideCircuitHistory([failure, opened, probe, closed].map(metadata => ({ metadata, receiptAuthentic: true })), 'project', 'repair');
  assert.equal(parsed.quarantined, 0);
  assert.equal(parsed.latest?.generation, 4);
  assert.deepEqual(queuePartnerGuideCircuitState(parsed, Date.parse('2026-10-29T00:06:11Z')), {
    generation: 4, eventDigest: closed.eventDigest, failures: 0, open: false, reason: null,
    openedAt: null, retryAt: null, probeToken: null, probeExpiresAt: null,
    quarantined: 0, authority: 'advisory-circuit-only',
  });
});

test('tampered, stale-generation and unbound circuit history is quarantined', () => {
  const first = buildQueuePartnerGuideCircuitEvent({ projectId: 'project', sourceRunId: 'run', taskClass: 'repair', kind: 'failure', failures: 1, reason: 'timeout' });
  const tampered = { ...first, failures: 2 };
  const stale = buildQueuePartnerGuideCircuitEvent({ projectId: 'project', sourceRunId: 'run', taskClass: 'repair', kind: 'opened', failures: 3, reason: 'timeout', openedAt: new Date().toISOString(), retryAt: new Date(Date.now() + 300_000).toISOString() });
  const foreign = buildQueuePartnerGuideCircuitEvent({ projectId: 'foreign', sourceRunId: 'run', taskClass: 'repair', kind: 'failure', failures: 1 });
  const parsed = parseQueuePartnerGuideCircuitHistory([{ metadata: tampered, receiptAuthentic: true }, { metadata: stale, receiptAuthentic: true }, { metadata: foreign, receiptAuthentic: true }], 'project', 'repair');
  assert.equal(parsed.latest, null);
  assert.equal(parsed.quarantined, 3);
});

test('storage operations fence generations, bound one recovery probe and retain advisory-only authority', () => {
  const source = readFileSync(new URL('./queue-partner-guide-circuit.ts', import.meta.url), 'utf8');
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /Stale Guide circuit generation/);
  assert.match(source, /durable-probe-already-claimed/);
  assert.match(source, /authority: 'advisory-circuit-only'/);
  assert.match(source, /Math\.min\(Math\.max\(input\.probeLeaseMs \?\? 30_000, 1_000\), 60_000\)/);
});

test('authenticated checkpoints bind a verified prefix and resume the event chain without deleting evidence', () => {
  const events = circuitEvents(105);
  const first = buildQueuePartnerGuideCircuitCheckpoint({ projectId: 'project', taskClass: 'repair', prefix: events.slice(0, 80), recordedAt: '2026-10-29T02:00:00Z' });
  const parsedFirst = parseQueuePartnerGuideCircuitCheckpoint({ metadata: first, receiptAuthentic: true }, 'project', 'repair');
  assert.equal(parsedFirst.reasonCode, null);
  assert.equal(first.prefixCount, 80);
  assert.equal(first.terminalGeneration, 80);
  assert.equal(first.retainedSuffixStartGeneration, 81);
  assert.equal(first.authority, 'audit-checkpoint-only');
  const suffix = parseQueuePartnerGuideCircuitHistory(events.slice(80).map(metadata => ({ metadata, receiptAuthentic: true })), 'project', 'repair', first);
  assert.equal(suffix.quarantined, 0);
  assert.equal(suffix.latest?.generation, 105);
  assert.equal(queuePartnerGuideCircuitState(suffix).failures, 105);
  assert.equal(events.length, 105, 'checkpointing keeps every original transition available for audit');
});

test('checkpoint tampering, stale suffixes and unbound receipts fail closed without circuit authority', () => {
  const events = circuitEvents(82);
  const checkpoint = buildQueuePartnerGuideCircuitCheckpoint({ projectId: 'project', taskClass: 'repair', prefix: events.slice(0, 80) });
  assert.equal(parseQueuePartnerGuideCircuitCheckpoint({ metadata: { ...checkpoint, prefixCount: 79 }, receiptAuthentic: true }, 'project', 'repair').checkpoint, null);
  assert.equal(parseQueuePartnerGuideCircuitCheckpoint({ metadata: checkpoint, receiptAuthentic: false }, 'project', 'repair').reasonCode, 'inauthentic-checkpoint-receipt');
  assert.equal(parseQueuePartnerGuideCircuitCheckpoint({ metadata: checkpoint, receiptAuthentic: true }, 'foreign', 'repair').reasonCode, 'unbound-checkpoint');
  const stale = { ...events[81]!, previousEventDigest: 'f'.repeat(64) };
  const parsed = parseQueuePartnerGuideCircuitHistory([{ metadata: stale, receiptAuthentic: true }], 'project', 'repair', checkpoint);
  assert.equal(parsed.quarantined, 1);
  assert.equal(parsed.latest?.generation, 80);
});

test('operational storage checkpoints bounded prefixes under the existing fence and retains original receipts', () => {
  const source = readFileSync(new URL('./queue-partner-guide-circuit.ts', import.meta.url), 'utf8');
  assert.match(source, /actionType: 'guide_circuit_checkpoint'/);
  assert.match(source, /original receipts retained, no circuit authority granted/);
  assert.match(source, /rows\.slice\(0, 80\)/);
  assert.match(source, /pass < 64/);
  assert.match(source, /loadOperationalCircuitHistory/);
  assert.doesNotMatch(source, /delete from action_receipts/i);
});

test('diagnostics distinguish cooldown, probe, overdue and quarantined reconciliation without reset authority',()=>{
  const opened=buildQueuePartnerGuideCircuitEvent({projectId:'project',sourceRunId:'run',taskClass:'repair',kind:'opened',failures:3,reason:'timeout',openedAt:'2026-10-29T00:00:00Z',retryAt:'2026-10-29T00:05:00Z',recordedAt:'2026-10-29T00:00:00Z'});
  const cooldown=summarizeQueuePartnerGuideCircuitDiagnostics([{metadata:opened,receiptAuthentic:true,runId:'run',workerId:'worker-a'}],'project',Date.parse('2026-10-29T00:01:00Z'))[0]!;
  assert.equal(cooldown.status,'cooldown');assert.deepEqual(cooldown.affectedWorkers,['worker-a']);assert.match(cooldown.reconciliation,/must not retry early/);
  const overdue=summarizeQueuePartnerGuideCircuitDiagnostics([{metadata:opened,receiptAuthentic:true}],'project',Date.parse('2026-10-29T00:06:00Z'))[0]!;assert.equal(overdue.status,'recovery-overdue');
  const probe=buildQueuePartnerGuideCircuitEvent({projectId:'project',sourceRunId:'run',taskClass:'repair',prior:opened,kind:'probe-claimed',failures:3,reason:'timeout',openedAt:opened.openedAt,retryAt:opened.retryAt,probeToken:'token',probeExpiresAt:'2026-10-29T00:07:00Z',recordedAt:'2026-10-29T00:06:00Z'});
  assert.equal(summarizeQueuePartnerGuideCircuitDiagnostics([{metadata:opened,receiptAuthentic:true},{metadata:probe,receiptAuthentic:true}],'project',Date.parse('2026-10-29T00:06:30Z'))[0]!.status,'recovery-probe');
  const tampered={...opened,failures:4};const quarantined=summarizeQueuePartnerGuideCircuitDiagnostics([{metadata:tampered,receiptAuthentic:true}],'project',Date.parse('2026-10-29T00:01:00Z'))[0]!;assert.equal(quarantined.status,'quarantined');assert.match(quarantined.reconciliation,/do not reset/);assert.equal(quarantined.authority,'diagnostic-only');
});
