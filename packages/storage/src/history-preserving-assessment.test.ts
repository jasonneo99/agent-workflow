import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {repairRevisionManifestHash} from './repaired-revision.js';

test('persisted jsonb manifest preserves exact source hash despite object key order',()=>{
 const original=[{path:'src/feature.ts',mode:0o644,hash:'a'.repeat(64)}];
 const persisted=[{hash:'a'.repeat(64),mode:0o644,path:'src/feature.ts'}];
 assert.equal(repairRevisionManifestHash(persisted),repairRevisionManifestHash(original));
 assert.notEqual(repairRevisionManifestHash([{...persisted[0],mode:0o600}]),repairRevisionManifestHash(original));
 assert.notEqual(repairRevisionManifestHash([{...persisted[0],hash:'b'.repeat(64)}]),repairRevisionManifestHash(original));
});

test('assessment attachment requires readonly exact authority and equivalent fresh acceptance',()=>{
 const source=readFileSync(new URL('./queue-coordinator.ts',import.meta.url),'utf8');
 const attachment=source.slice(source.indexOf('export async function attachCoordinatorChild'),source.indexOf('export async function finishQueueCoordinator'));
 for(const guard of ["operator_history_assessment_reserved","m?.source!=='queue-coordinator-assessment'","m.provenanceKind!=='authorized-current-baseline-assessment'",'acceptanceDigest(m.historyAssessment)!==acceptanceDigest(proof.assessment)','allowed_write_paths.length','contract?.subjectHash!==proof.assessment?.subjectHash','contract?.originRunId!==runId','contract?.taskHash!==acceptanceDigest(child.task)','repairRevisionRequirementsDigest(contract)!==repairRevisionRequirementsDigest(effective.contract)'])assert.ok(attachment.includes(guard),guard);
 assert.ok(attachment.indexOf('Assessment child must preserve exact readonly provenance')<attachment.indexOf("set child_run_id=$3"),'Reject invalid child before assignment mutation');
});
