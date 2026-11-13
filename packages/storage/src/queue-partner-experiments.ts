import { createHash } from 'node:crypto';
import { withClient } from './client.js';
import { appendActionReceipt } from './receipt-writer.js';
import type { Client } from 'pg';

export type PartnerDelegationArm = 'partner-direct' | 'specialist';
export type PartnerGuideArm = 'guided' | 'unguided';
export interface QueuePartnerExperimentAssignment { experimentId: 'specialist-delegation-v1' | 'guide-plane-v1'; arm: string; assignmentSource: 'natural-policy' | 'deterministic-sampling' }
export interface QueuePartnerExperimentExposure {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  design: 'factorial';
  cohortKey: string;
  assignments: [QueuePartnerExperimentAssignment, QueuePartnerExperimentAssignment];
  assignedAt: string;
  authority: 'measurement-only';
  exposureDigest: string;
}
export interface QueuePartnerExperimentObservation { runId: string; delegationArm: PartnerDelegationArm; guideArm: PartnerGuideArm; accepted: boolean; durationMs: number | null }

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cellKey = (delegation: PartnerDelegationArm, guide: PartnerGuideArm) => `${delegation}:${guide}` as const;
const exposureCore = (value: Omit<QueuePartnerExperimentExposure, 'exposureDigest'>) => ({
  schemaVersion: value.schemaVersion,
  runId: value.runId,
  projectId: value.projectId,
  design: value.design,
  cohortKey: value.cohortKey,
  assignments: value.assignments.map(item => ({ experimentId: item.experimentId, arm: item.arm, assignmentSource: item.assignmentSource })) as QueuePartnerExperimentExposure['assignments'],
  assignedAt: value.assignedAt,
  authority: value.authority,
});

export function buildQueuePartnerExperimentExposure(input: { runId: string; projectId: string; workerAgentId: string; guideArm: PartnerGuideArm; assignedAt?: string }): QueuePartnerExperimentExposure {
  const delegationArm: PartnerDelegationArm = input.workerAgentId === 'queue-partner' ? 'partner-direct' : 'specialist';
  const assignments: QueuePartnerExperimentExposure['assignments'] = [
    { experimentId: 'specialist-delegation-v1', arm: delegationArm, assignmentSource: 'natural-policy' },
    { experimentId: 'guide-plane-v1', arm: input.guideArm, assignmentSource: 'deterministic-sampling' },
  ];
  const core = { schemaVersion: 1 as const, runId: input.runId, projectId: input.projectId, design: 'factorial' as const, cohortKey: cellKey(delegationArm, input.guideArm), assignments, assignedAt: input.assignedAt ?? new Date().toISOString(), authority: 'measurement-only' as const };
  return { ...core, exposureDigest: hash(exposureCore(core)) };
}

export function validateQueuePartnerExperimentExposure(value: unknown, runId: string, projectId: string): QueuePartnerExperimentExposure | null {
  if (!value || typeof value !== 'object') return null;
  const exposure = value as QueuePartnerExperimentExposure;
  if (exposure.schemaVersion !== 1 || exposure.runId !== runId || exposure.projectId !== projectId || exposure.design !== 'factorial' || exposure.authority !== 'measurement-only' || !Array.isArray(exposure.assignments) || exposure.assignments.length !== 2) return null;
  const delegation = exposure.assignments.find(item => item.experimentId === 'specialist-delegation-v1');
  const guide = exposure.assignments.find(item => item.experimentId === 'guide-plane-v1');
  if (!delegation || !['partner-direct', 'specialist'].includes(delegation.arm) || delegation.assignmentSource !== 'natural-policy' || !guide || !['guided', 'unguided'].includes(guide.arm) || guide.assignmentSource !== 'deterministic-sampling') return null;
  const { exposureDigest, ...core } = exposure;
  if (!/^[a-f0-9]{64}$/u.test(exposureDigest) || hash(exposureCore(core)) !== exposureDigest || exposure.cohortKey !== cellKey(delegation.arm as PartnerDelegationArm, guide.arm as PartnerGuideArm)) return null;
  return exposure;
}

export async function registerQueuePartnerExperimentExposureOnClient(client:Client,input: { runId: string; workerAgentId: string; guideArm: PartnerGuideArm; assignedAt?: Date }) {
      const run = (await client.query('select project_id::text "projectId" from workflow_runs where id=$1 for update', [input.runId])).rows[0];
      if (!run?.projectId) throw new Error('Experiment exposure run is unbound');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${run.projectId}:partner-experiment:${input.runId}`]);
      const existing = (await client.query("select metadata from action_receipts where run_id=$1 and action_type='queue_partner_experiment_exposure' order by created_at,id limit 2", [input.runId])).rows;
      const exposure = buildQueuePartnerExperimentExposure({ runId: input.runId, projectId: run.projectId, workerAgentId: input.workerAgentId, guideArm: input.guideArm, assignedAt: input.assignedAt?.toISOString() });
      if (existing.length) {
        const prior = validateQueuePartnerExperimentExposure(existing[0].metadata, input.runId, run.projectId);
        if (existing.length !== 1 || !prior || prior.cohortKey !== exposure.cohortKey) throw new Error('Conflicting Queue Partner experiment exposure');
        return { recorded: false, exposure: prior };
      }
      await appendActionReceipt(client, { runId: input.runId, agentId: 'queue-partner', actionType: 'queue_partner_experiment_exposure', target: 'partner-experiments', summary: `Recorded measurement-only factorial exposure ${exposure.cohortKey} before execution.`, metadata: JSON.stringify(exposure) });
      return { recorded: true, exposure };
}

export async function registerQueuePartnerExperimentExposure(input: { runId: string; workerAgentId: string; guideArm: PartnerGuideArm; assignedAt?: Date }) {
  return withClient(async client => {
    await client.query('begin');
    try {
      const result=await registerQueuePartnerExperimentExposureOnClient(client,input);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

export function summarizeQueuePartnerExperiments(input: readonly QueuePartnerExperimentObservation[]) {
  const valid = input.slice(0, 1000).filter(row => row.runId && ['partner-direct', 'specialist'].includes(row.delegationArm) && ['guided', 'unguided'].includes(row.guideArm));
  const cells = (['partner-direct', 'specialist'] as const).flatMap(delegationArm => (['unguided', 'guided'] as const).map(guideArm => {
    const rows = valid.filter(row => row.delegationArm === delegationArm && row.guideArm === guideArm);
    const accepted = rows.filter(row => row.accepted).length;
    const durations = rows.map(row => row.durationMs).filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
    return { cohortKey: cellKey(delegationArm, guideArm), delegationArm, guideArm, samples: rows.length, accepted, acceptanceRate: rows.length ? accepted / rows.length : null, averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null };
  }));
  const byKey = new Map(cells.map(cell => [cell.cohortKey, cell]));
  const rate = (key: ReturnType<typeof cellKey>) => byKey.get(key)?.acceptanceRate ?? null;
  const directGuided = rate('partner-direct:guided'), directUnguided = rate('partner-direct:unguided'), specialistGuided = rate('specialist:guided'), specialistUnguided = rate('specialist:unguided');
  const interactionEffect = [directGuided, directUnguided, specialistGuided, specialistUnguided].every(value => value !== null) ? (specialistGuided! - specialistUnguided!) - (directGuided! - directUnguided!) : null;
  const minimumSamplesPerCell = 20, minimumAcceptedPerCell = 3;
  const powered = cells.every(cell => cell.samples >= minimumSamplesPerCell);
  const acceptedOutcomeCoverage = cells.every(cell => cell.accepted >= minimumAcceptedPerCell);
  return {
    version: 1,
    design: 'factorial' as const,
    createsRuns: false,
    changesQueueEligibility: false,
    cells,
    interactionEffect,
    gate: { minimumSamplesPerCell, minimumAcceptedPerCell, powered, acceptedOutcomeCoverage, promotionEligible: powered && acceptedOutcomeCoverage },
    decision: { applied: false, authority: 'measurement-only' as const, recommendation: powered && acceptedOutcomeCoverage ? 'eligible-for-independent-promotion-review' : 'collect-natural-traffic' },
  };
}

export async function queuePartnerExperimentReport(projectId?: string) {
  return withClient(async client => {
    const rows = (await client.query(`select r.id::text "runId",
      coalesce(e.metadata->'assignments'->0->>'arm','invalid') "delegationArm",
      coalesce(e.metadata->'assignments'->1->>'arm','invalid') "guideArm",
      exists(select 1 from memory_nodes n where n.project_id=r.project_id::text and n.metadata->>'memoryKind'='queue-partner-remedy-verification' and n.metadata->>'repairRunId'=r.id::text) accepted,
      case when r.started_at is not null and r.finished_at is not null then extract(epoch from (r.finished_at-r.started_at))*1000 end "durationMs"
      from workflow_runs r join action_receipts e on e.run_id=r.id and e.action_type='queue_partner_experiment_exposure'
      where ($1::uuid is null or r.project_id=$1::uuid) order by r.started_at desc,r.id desc limit 1000`, [projectId ?? null])).rows;
    return summarizeQueuePartnerExperiments(rows.map(row => ({ ...row, durationMs: row.durationMs === null ? null : Number(row.durationMs) })) as QueuePartnerExperimentObservation[]);
  });
}
