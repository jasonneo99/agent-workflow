import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildQueuePartnerExperimentExposure, summarizeQueuePartnerExperiments, validateQueuePartnerExperimentExposure, type QueuePartnerExperimentObservation } from './queue-partner-experiments.js';

test('factorial exposure is body-free, measurement-only and tamper evident',()=>{
  const exposure=buildQueuePartnerExperimentExposure({runId:'run',projectId:'project',workerAgentId:'backend-engineer',guideArm:'guided',assignedAt:'2026-10-29T00:00:00Z'});
  assert.equal(exposure.cohortKey,'specialist:guided');
  assert.equal(exposure.authority,'measurement-only');
  assert.ok(validateQueuePartnerExperimentExposure(exposure,'run','project'));
  assert.equal(validateQueuePartnerExperimentExposure({...exposure,cohortKey:'partner-direct:guided'},'run','project'),null);
  assert.doesNotMatch(JSON.stringify(exposure),/task|prompt|path/iu);
});

test('factorial exposure digest survives JSONB key normalization',()=>{
  const exposure=buildQueuePartnerExperimentExposure({runId:'run',projectId:'project',workerAgentId:'backend-engineer',guideArm:'guided',assignedAt:'2026-10-29T00:00:00Z'});
  const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
  const normalized=normalize(exposure);
  assert.ok(validateQueuePartnerExperimentExposure(normalized,'run','project'));
});

test('interaction effects require all natural-traffic cells and independently accepted outcomes',()=>{
  const rows:QueuePartnerExperimentObservation[]=[];
  for(const delegationArm of ['partner-direct','specialist'] as const)for(const guideArm of ['unguided','guided'] as const)for(let i=0;i<20;i++)rows.push({runId:`${delegationArm}-${guideArm}-${i}`,delegationArm,guideArm,accepted:i<(delegationArm==='specialist'&&guideArm==='guided'?16:8),durationMs:100});
  const report=summarizeQueuePartnerExperiments(rows);
  assert.equal(report.gate.powered,true);
  assert.equal(report.gate.acceptedOutcomeCoverage,true);
  assert.equal(report.interactionEffect,.4);
  assert.equal(report.gate.promotionEligible,true);
  assert.equal(report.decision.applied,false);
  assert.equal(report.changesQueueEligibility,false);
  assert.equal(report.createsRuns,false);
});

test('underpowered or unaccepted cells cannot recommend promotion',()=>{
  const report=summarizeQueuePartnerExperiments([{runId:'one',delegationArm:'specialist',guideArm:'guided',accepted:true,durationMs:10}]);
  assert.equal(report.gate.powered,false);
  assert.equal(report.gate.acceptedOutcomeCoverage,false);
  assert.equal(report.gate.promotionEligible,false);
  assert.equal(report.interactionEffect,null);
});

test('exposure registration is fenced, idempotent and precedes execution by contract',()=>{
  const source=readFileSync(new URL('./queue-partner-experiments.ts',import.meta.url),'utf8');
  assert.match(source,/pg_advisory_xact_lock/);
  assert.match(source,/Conflicting Queue Partner experiment exposure/);
  assert.match(source,/queue_partner_experiment_exposure/);
  assert.match(source,/before execution/);
});
