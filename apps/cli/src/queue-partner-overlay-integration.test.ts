import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('./commands/daemon.ts',import.meta.url),'utf8');
test('queue and exact run pages share one context-bound partner overlay',()=>{
 assert.match(code,/renderQueuePartnerOverlay\(partnerProjects, resolvedProjectFilter \|\| ctx.rootDir\)/);
 assert.match(code,/renderQueuePartnerOverlay\(input.partnerProjects, input.run.projectRootUri, \{runId:input.run.id\}\)/);
 assert.match(code,/partnerProjects: \(await listProjectStorageSummaries\(100\)\).filter\(project => project.rootUri === details.run!\.projectRootUri\)/);
});
test('live page refresh cannot erase an open partner conversation',()=>{
 const queue=code.slice(code.indexOf('function renderQueueHtml('),code.indexOf('function renderReadinessGroup('));
 assert.match(queue,/queueCardRefreshScript\(\)/);
 assert.match(queue,/if \(event.data.changed\) cards.request\(\)/);
 assert.doesNotMatch(queue,/window.location.reload/);
 assert.match(queue,/data-queue-card-key/);
 for(const name of ['counts','controls','attention','cards'])assert.ok(queue.includes(`data-queue-live-region="${name}"`));
 assert.match(code,/id="queue-watch-refresh" hidden/);
 assert.match(code,/setTimeout\(\(\) => \{ if \(document.documentElement.dataset.queuePartnerOpen !== "true"\) window.location.reload\(\)/);
});

test('queue activity exposes coordinator observations without treating dashboard polling as a scheduler check',()=>{
 const route=code.slice(code.indexOf('if (requestUrl.pathname === "/api/queue-partner-activity")'),code.indexOf('if (requestUrl.pathname === "/api/queue")'));
 assert.match(route,/coordinator:await readPartnerQueueObservation\(ctx.rootDir\)/);
 assert.doesNotMatch(route,/recordPartnerQueueObservation|createWorkflowRun|requestActionApproval/);
 const coordinator=readFileSync(new URL('./commands/queue-coordinator.ts',import.meta.url),'utf8');
 assert.match(coordinator,/if\(options.execute&&options.watch&&options.allQueuedProjects\)/);
 assert.match(coordinator,/await recordPartnerQueueObservation\(ctx.rootDir,report\)/);
 assert.match(coordinator,/catch\{report=\{\.\.\.report,observationUnavailable:true\};\}/);
});
