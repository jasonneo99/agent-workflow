import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const daemon=readFileSync(new URL('./commands/daemon.ts',import.meta.url),'utf8');
const coordinator=readFileSync(new URL('./commands/queue-coordinator.ts',import.meta.url),'utf8');
test('activity endpoint is exact registered project, local GET, no-store and read-only',()=>{
 const start=daemon.indexOf('if (requestUrl.pathname === "/api/queue-partner-activity")');
 const block=daemon.slice(start,daemon.indexOf('if (requestUrl.pathname === "/api/queue")',start));
 assert.match(block,/request.method !== "GET"/);
 assert.match(block,/isTrustedLocalDashboardRequest\(request\)/);
 assert.match(block,/find\(project => project.rootUri === root\)/);
 assert.match(block,/buildQueuePartnerActivity\(registered.id, registered.rootUri, runId\)/);
 assert.match(block,/"cache-control":"no-store"/);
 assert.doesNotMatch(block,/recordRunAction|acquireWorkIntent|runWorkerOnce|createWorkflowRun|approve|restart|initialize/);
});
test('only execution passes record decisions, with independent observation intents and visible telemetry failures',()=>{
 assert.match(coordinator,/if\(execute\)for\(const family/);
 assert.match(coordinator,/fileScopes:\['runtime\/queue-partner\/activity'\]/);
 assert.match(coordinator,/recordQueuePartnerDecision\(/);
 assert.match(coordinator,/activityWarnings.push/);
 assert.match(coordinator,/execution outcome is not relabeled/);
 assert.match(coordinator,/repairLanes:QUEUE_SHARED_ITEM_LIMIT,verifierLanes:1/);
 assert.match(coordinator,/state==='verified'\?'verified':'outcome'/);
 assert.doesNotMatch(coordinator,/queue_partner_decision.*(?:dismiss|approve)Workflow/);
});
