import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { evaluateQueuePartnerGuideActorReadiness, queuePartnerGuideActorContract, queuePartnerGuideActorFingerprint } from './queue-partner-guide-readiness.js';

test('deployed Guide readiness binds the maintained registry card semantic generation', () => {
  const definition = YAML.parse(readFileSync(new URL('../../../agents/automatic/workflow-guide.yaml', import.meta.url), 'utf8'));
  const ready = evaluateQueuePartnerGuideActorReadiness({ sourcePath: queuePartnerGuideActorContract.sourcePath, definition, updatedAt: '2026-10-29T00:00:00Z' });
  assert.equal(ready.ready, true); assert.equal(ready.reason, 'guide-actor-current'); assert.equal(ready.actualFingerprint, queuePartnerGuideActorFingerprint); assert.equal(ready.authority, 'readiness-only');
});

test('missing and stale Guide actors fail readiness without mutation or execution authority', () => {
  assert.equal(evaluateQueuePartnerGuideActorReadiness(null).reason, 'guide-actor-missing');
  const stale = evaluateQueuePartnerGuideActorReadiness({ sourcePath: queuePartnerGuideActorContract.sourcePath, definition: { ...queuePartnerGuideActorContract, model_tier: 'reasoning', outputs: { schema: queuePartnerGuideActorContract.outputSchema } } });
  assert.equal(stale.ready, false); assert.equal(stale.reason, 'guide-actor-stale');
  const source = readFileSync(new URL('./queue-partner-guide-readiness.ts', import.meta.url), 'utf8'); assert.doesNotMatch(source, /insert into|update agents|delete from/iu);
});
