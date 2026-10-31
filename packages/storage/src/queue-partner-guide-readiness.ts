import { createHash } from 'node:crypto';
import { withClient } from './client.js';
import { stableJson } from './registry.js';

export const queuePartnerGuideActorContract = {
  id: 'workflow-guide', sourcePath: 'agents/automatic/workflow-guide.yaml', category: 'automatic',
  modelTier: 'fast', autonomy: 0, outputSchema: 'workflow_guide_observation',
} as const;
export const queuePartnerGuideActorFingerprint = createHash('sha256').update(stableJson(queuePartnerGuideActorContract)).digest('hex');

export function evaluateQueuePartnerGuideActorReadiness(row: { sourcePath?: unknown; definition?: unknown; updatedAt?: unknown } | null | undefined) {
  const definition = row?.definition && typeof row.definition === 'object' ? row.definition as Record<string, any> : null;
  const actual = definition ? { id: definition.id, sourcePath: row?.sourcePath, category: definition.category, modelTier: definition.model_tier, autonomy: definition.autonomy, outputSchema: definition.outputs?.schema } : null;
  const actualFingerprint = actual ? createHash('sha256').update(stableJson(actual)).digest('hex') : null;
  const ready = actualFingerprint === queuePartnerGuideActorFingerprint;
  return { ready, reason: !row ? 'guide-actor-missing' as const : ready ? 'guide-actor-current' as const : 'guide-actor-stale' as const, expectedFingerprint: queuePartnerGuideActorFingerprint, actualFingerprint, registryUpdatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : null, authority: 'readiness-only' as const };
}

export async function queuePartnerGuideActorReadiness(runId: string) {
  return withClient(async client => {
    const row = (await client.query(`select a.source_path "sourcePath",a.definition,a.updated_at::text "updatedAt"
      from workflow_runs r left join agents a on a.id=$2 where r.id=$1`, [runId, queuePartnerGuideActorContract.id])).rows[0];
    if (!row) return { ...evaluateQueuePartnerGuideActorReadiness(null), reason: 'guide-run-missing' as const };
    return evaluateQueuePartnerGuideActorReadiness(row.sourcePath ? row : null);
  });
}
