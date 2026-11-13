import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

test('CLI exposes bounded observational Guide adoption metrics',()=>{
 const source=readFileSync(new URL('./commands/learning.ts',import.meta.url),'utf8');
 const command=source.slice(source.indexOf("command('guide-adoption-hold-metrics')"),source.indexOf('program\n    .command("learning-proposals")'));
 assert.match(command,/queuePartnerGuideRegistryHoldMetrics/);
 assert.match(command,/duplicate receipt\(s\) suppressed/);
 assert.match(command,/report\.calibration\.selectedThresholdMs/);
 assert.match(command,/report\.calibration\.alertThresholdMs/);
 assert.match(command,/stableGenerationsObserved/);
 assert.match(command,/confidenceBandLowerMs/);
 assert.match(command,/existing alerts remain visible/);
 assert.match(command,/resolved samples/);
 assert.match(command,/restartAuthority:false/);
 assert.match(command,/replayAuthority:false/);
 assert.match(command,/primaryOutcomeAccepted:false/);
 assert.doesNotMatch(command,/reconcileQueuePartnerGuideRegistryHold|retryFailedWorkflowRun|replayWorkflowRun|runWorkerOnce/);
});

test('dashboard exposes hold latency and coalescing without action authority',()=>{
 const source=readFileSync(new URL('./commands/daemon.ts',import.meta.url),'utf8');
 assert.match(source,/\/api\/guide-adoption-hold-metrics/);
 assert.match(source,/queuePartnerGuideRegistryHoldMetrics\(selected\.id/);
 assert.match(source,/Guide Adoption Holds/);
 assert.match(source,/duplicate receipt\(s\) suppressed/);
 assert.match(source,/report\.calibration\.selectedThresholdMs/);
 assert.match(source,/report\.calibration\.alertThresholdMs/);
 assert.match(source,/report\.calibration\.candidateThresholdMs/);
 assert.match(source,/report\.calibration\.stableGenerationRequirement/);
 assert.match(source,/preserves open alerts/);
 assert.match(source,/report\.calibration\.sampleCount/);
 assert.match(source,/Lag alerts are observational only/);
 assert.match(source,/restartAuthority: false/);
 assert.match(source,/replayAuthority: false/);
 assert.match(source,/primaryOutcomeAccepted: false/);
});
