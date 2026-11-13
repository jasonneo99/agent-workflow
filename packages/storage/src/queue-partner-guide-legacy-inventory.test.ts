import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildQueuePartnerExperimentExposure } from './queue-partner-experiments.js';
import { buildGuidePolicyTransition, summarizeQueuePartnerGuidePolicy, type QueuePartnerGuideObservation } from './queue-partner-guide-policy.js';
import { createGuideEvidenceReduction, decodeGuideEvidenceReductionCheckpoint, decodeLegacyGuideEvidenceCursor, encodeGuideEvidenceReductionCheckpoint, encodeLegacyGuideEvidenceCursor, finalizeGuideEvidenceReduction, reduceLegacyGuideEvidencePage, summarizeLegacyGuideEvidence, type LegacyGuideEvidenceRow } from './queue-partner-guide-legacy-inventory.js';

test('legacy Guide inventory separates compatible schema-v1 evidence from tampering without authority', () => {
  const observations: QueuePartnerGuideObservation[] = [
    ...Array.from({ length: 40 }, (_, index) => ({ runId: `g${index}`, taskClass: 'repair', cohort: 'guided' as const, accepted: index < 39, durationMs: 90 })),
    ...Array.from({ length: 40 }, (_, index) => ({ runId: `u${index}`, taskClass: 'repair', cohort: 'unguided' as const, accepted: index < 5, durationMs: 100 })),
  ];
  const report = summarizeQueuePartnerGuidePolicy(observations, 'repair');
  const transition = buildGuidePolicyTransition({ projectId: 'project', sourceRunId: 'run-a', report, recordedAt: '2026-10-29T00:00:00Z' });
  const exposure = buildQueuePartnerExperimentExposure({ runId: 'run-b', projectId: 'project', workerAgentId: 'implementation-agent', guideArm: 'guided', assignedAt: '2026-10-29T00:00:00Z' });
  const rows: LegacyGuideEvidenceRow[] = [
    { projectId: 'project', runId: 'run-a', actionType: 'guide_policy_transition', taskClass: 'repair', metadata: transition, receiptHash: 'a'.repeat(64), receiptAuthentic: true, createdAt: transition.recordedAt },
    { projectId: 'project', runId: 'run-b', actionType: 'queue_partner_experiment_exposure', taskClass: 'factorial', metadata: exposure, receiptHash: 'b'.repeat(64), receiptAuthentic: true, createdAt: exposure.assignedAt },
    { projectId: 'foreign', runId: 'run-c', actionType: 'queue_partner_experiment_exposure', taskClass: 'factorial', metadata: { ...exposure, runId: 'run-c', projectId: 'foreign', cohortKey: 'tampered' }, receiptHash: 'c'.repeat(64), receiptAuthentic: true, createdAt: exposure.assignedAt },
  ];
  const inventory = summarizeLegacyGuideEvidence(rows);
  assert.equal(inventory.legacyCompatible, 2);
  assert.equal(inventory.quarantined, 1);
  assert.equal(inventory.authority, 'inventory-only');
  assert.equal(inventory.executionAcceptance, 'unverified');
  assert.match(inventory.findings.find(item => item.status === 'quarantined')!.reconciliation, /do not rewrite or infer acceptance/);
});

test('legacy Guide inventory is bounded and contains no mutation path', () => {
  const source = readFileSync(new URL('./queue-partner-guide-legacy-inventory.ts', import.meta.url), 'utf8');
  assert.match(source, /limit 501/);
  assert.match(source, /rows\.slice\(0, 500\)/);
  assert.doesNotMatch(source, /insert into|update action_receipts|delete from/iu);
});

test('Guide inventory cursors bind project, coverage, and checkpoint immutably',()=>{
 const payload={schemaVersion:1 as const,projectId:'project',snapshot:{createdAt:'2026-10-29T00:10:00Z',receiptId:'11111111-1111-4111-8111-111111111111'},after:{createdAt:'2026-10-29T00:05:00Z',receiptId:'22222222-2222-4222-8222-222222222222'},pageStartAfter:null,pageDigest:'a'.repeat(64),checkpointHash:'b'.repeat(64),pageIndex:1};
 const cursor=encodeLegacyGuideEvidenceCursor(payload);
 assert.deepEqual(decodeLegacyGuideEvidenceCursor(cursor,'project'),payload);
 assert.throws(()=>decodeLegacyGuideEvidenceCursor(cursor,'other-project'),/immutable checkpoint validation/);
 const envelope=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));envelope.payload.pageIndex=2;
 assert.throws(()=>decodeLegacyGuideEvidenceCursor(Buffer.from(JSON.stringify(envelope)).toString('base64url'),'project'),/immutable checkpoint validation/);
});

test('streaming Guide reduction emits one checkpoint-bound manifest only after complete coverage',()=>{
 const observations:QueuePartnerGuideObservation[]=[...Array.from({length:20},(_,index)=>({runId:`g${index}`,taskClass:'repair',cohort:'guided' as const,accepted:true,durationMs:80})),...Array.from({length:20},(_,index)=>({runId:`u${index}`,taskClass:'repair',cohort:'unguided' as const,accepted:false,durationMs:100}))];
 const report=summarizeQueuePartnerGuidePolicy(observations,'repair'),first=buildGuidePolicyTransition({projectId:'project',sourceRunId:'run-a',report,recordedAt:'2026-10-29T00:00:00Z'}),second=buildGuidePolicyTransition({projectId:'project',sourceRunId:'run-b',report,prior:first,recordedAt:'2026-10-29T00:01:00Z'}),exposure=buildQueuePartnerExperimentExposure({runId:'run-c',projectId:'project',workerAgentId:'implementation-agent',guideArm:'guided',assignedAt:'2026-10-29T00:02:00Z'});
 const rows:LegacyGuideEvidenceRow[]=[{receiptId:'11111111-1111-4111-8111-111111111111',projectId:'project',runId:'run-a',actionType:'guide_policy_transition',taskClass:'repair',metadata:first,receiptHash:'a'.repeat(64),receiptAuthentic:true,createdAt:first.recordedAt},{receiptId:'22222222-2222-4222-8222-222222222222',projectId:'project',runId:'run-b',actionType:'guide_policy_transition',taskClass:'repair',metadata:second,receiptHash:'b'.repeat(64),receiptAuthentic:true,createdAt:second.recordedAt},{receiptId:'33333333-3333-4333-8333-333333333333',projectId:'project',runId:'run-c',actionType:'queue_partner_experiment_exposure',taskClass:'factorial',metadata:exposure,receiptHash:'c'.repeat(64),receiptAuthentic:true,createdAt:exposure.assignedAt}];
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),digest=(items:LegacyGuideEvidenceRow[])=>sha(JSON.stringify(items.map(row=>[row.receiptId,row.projectId,row.runId,row.actionType,row.createdAt,row.receiptHash]))),snapshot={createdAt:rows[2]!.createdAt,receiptId:rows[2]!.receiptId!},firstDigest=digest(rows.slice(0,2)),firstCheckpoint=sha(`GENESIS:${firstDigest}`),firstEnd={createdAt:rows[1]!.createdAt,receiptId:rows[1]!.receiptId!};
 let state=reduceLegacyGuideEvidencePage(createGuideEvidenceReduction('project'),{projectId:'project',pageIndex:1,items:rows.slice(0,2),coverage:{startAfter:null,end:firstEnd,snapshot,pageDigest:firstDigest,checkpointHash:firstCheckpoint},complete:false});
 assert.equal(state.complete,false);assert.throws(()=>finalizeGuideEvidenceReduction(state),/before full snapshot coverage/);assert.equal(Object.values(state.taskClasses.repair!.evidenceModes)[0]!.length,512,'each probabilistic decision index stays fixed at 256 bytes');
 const secondDigest=digest(rows.slice(2)),secondCheckpoint=sha(`${firstCheckpoint}:${secondDigest}`);state=reduceLegacyGuideEvidencePage(state,{projectId:'project',pageIndex:2,items:rows.slice(2),coverage:{startAfter:firstEnd,end:snapshot,snapshot,pageDigest:secondDigest,checkpointHash:secondCheckpoint},complete:true});
 const manifest=finalizeGuideEvidenceReduction(state);assert.equal(manifest.conclusion,'compatible');assert.equal(manifest.receipts,3);assert.equal(manifest.pages,2);assert.equal(manifest.manifestSignature.value.length,64);assert.deepEqual(manifest.grants,{repair:false,replay:false,approval:false,acceptance:false});assert.equal(manifest.executionAcceptance,'unverified');
});

test('streaming Guide reduction fails closed on changed pages and quarantines invalid evidence without advancing authority',()=>{
 const row:LegacyGuideEvidenceRow={receiptId:'11111111-1111-4111-8111-111111111111',projectId:'project',runId:'run-a',actionType:'queue_partner_experiment_exposure',taskClass:'factorial',metadata:{tampered:true},receiptHash:'a'.repeat(64),receiptAuthentic:true,createdAt:'2026-10-29T00:00:00Z'},sha=(value:string)=>createHash('sha256').update(value).digest('hex'),pageDigest=sha(JSON.stringify([[row.receiptId,row.projectId,row.runId,row.actionType,row.createdAt,row.receiptHash]])),checkpointHash=sha(`GENESIS:${pageDigest}`),position={createdAt:row.createdAt,receiptId:row.receiptId!};
 const state=reduceLegacyGuideEvidencePage(createGuideEvidenceReduction('project'),{projectId:'project',pageIndex:1,items:[row],coverage:{startAfter:null,end:position,snapshot:position,pageDigest,checkpointHash},complete:true}),manifest=finalizeGuideEvidenceReduction(state);
 assert.equal(manifest.conclusion,'quarantined');assert.equal(manifest.quarantined,1);assert.deepEqual(manifest.taskClasses[0]!.reasons,['invalid-exposure-contract']);
 assert.throws(()=>reduceLegacyGuideEvidencePage(createGuideEvidenceReduction('project'),{projectId:'project',pageIndex:1,items:[row],coverage:{startAfter:null,end:position,snapshot:position,pageDigest,checkpointHash:'0'.repeat(64)},complete:true}),/checkpoint failed verification/);
});

test('resumable Guide reduction checkpoints are authenticated, expiring, and bound to exact partial state',()=>{
 const row:LegacyGuideEvidenceRow={receiptId:'11111111-1111-4111-8111-111111111111',projectId:'project',runId:'run-a',actionType:'queue_partner_experiment_exposure',taskClass:'factorial',metadata:{tampered:true},receiptHash:'a'.repeat(64),receiptAuthentic:true,createdAt:'2026-10-29T00:00:00Z'},sha=(value:string)=>createHash('sha256').update(value).digest('hex'),pageDigest=sha(JSON.stringify([[row.receiptId,row.projectId,row.runId,row.actionType,row.createdAt,row.receiptHash]])),checkpointHash=sha(`GENESIS:${pageDigest}`),end={createdAt:row.createdAt,receiptId:row.receiptId!},snapshot={createdAt:'2026-10-29T00:01:00Z',receiptId:'22222222-2222-4222-8222-222222222222'};
 const state=reduceLegacyGuideEvidencePage(createGuideEvidenceReduction('project'),{projectId:'project',pageIndex:1,items:[row],coverage:{startAfter:null,end,snapshot,pageDigest,checkpointHash},complete:false}),cursor=encodeLegacyGuideEvidenceCursor({schemaVersion:1,projectId:'project',snapshot,after:end,pageStartAfter:null,pageDigest,checkpointHash,pageIndex:1}),key=randomBytes(32),issuedAt='2026-10-29T00:00:10.000Z',expiresAt='2026-10-29T00:15:10.000Z',payload={schemaVersion:1 as const,projectId:'project',issuedAt,expiresAt,cursor,state,authority:'resume-only' as const,executionAcceptance:'unverified' as const,grants:{repair:false as const,replay:false as const,approval:false as const,promotion:false as const,acceptance:false as const}};
 const token=encodeGuideEvidenceReductionCheckpoint(payload,key),decoded=decodeGuideEvidenceReductionCheckpoint(token,'project',key,new Date('2026-10-29T00:05:00Z'));
 assert.deepEqual(decoded,payload);assert.deepEqual(decoded.grants,{repair:false,replay:false,approval:false,promotion:false,acceptance:false});assert.equal(decoded.state.complete,false);assert.ok(token.length<2_000,'compressed checkpoint stays practical for the bounded synthetic state');
 const [body,signature]=token.split('.');assert.throws(()=>decodeGuideEvidenceReductionCheckpoint(`${body!.slice(0,-1)}A.${signature}`,'project',key,new Date('2026-10-29T00:05:00Z')),/authentication failed/);
 assert.throws(()=>decodeGuideEvidenceReductionCheckpoint(token,'project',randomBytes(32),new Date('2026-10-29T00:05:00Z')),/authentication failed/);
 assert.throws(()=>decodeGuideEvidenceReductionCheckpoint(token,'project',key,new Date(expiresAt)),/expired/);
 assert.throws(()=>decodeGuideEvidenceReductionCheckpoint(token,'other-project',key,new Date('2026-10-29T00:05:00Z')),/state is invalid|binding is invalid/);
 assert.throws(()=>encodeGuideEvidenceReductionCheckpoint({...payload,state:{...state,checkpointHash:'f'.repeat(64)}},key),/binding is invalid/);
});
