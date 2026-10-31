import assert from 'node:assert/strict';
import test from 'node:test';
import {Script} from 'node:vm';
import {readFileSync} from 'node:fs';
import {renderQueueStatusHtml,queueStatusClientScript} from './queue-status.js';
test('queue table has precisely the requested columns, accessible filters and responsive layout',()=>{
 const html=renderQueueStatusHtml();assert.deepEqual([...html.matchAll(/<th scope="col">([^<]+)<\/th>/gu)].map(m=>m[1]),['Name','Status','Issue','Fix']);
 assert.match(html,/<title>Queue status · Agent Workflow<\/title>/);assert.match(html,/meta name="viewport"/);assert.match(html,/aria-describedby="queue-note"/);
 for(const id of ['scope','collection','project','status','attention','search','refresh','notice','rows','count-review','count-history'])assert.ok(html.includes(`id="${id}"`));assert.match(html,/@media\(max-width:650px\)/);
 assert.match(html,/<select id="scope"><option value="all">Whole queue/);assert.match(html,/Project \(view filter\)/);assert.match(html,/id="queue-partner-overlay"/);assert.doesNotMatch(html,/dashboard-question-project/);
});
test('family view exposes revisit filtering, real-working totals and expandable attempts without claiming resolution',()=>{
 const html=renderQueueStatusHtml(),code=queueStatusClientScript();assert.match(html,/Grouped by family/);assert.match(html,/Families working now/);assert.match(html,/Needs revisiting/);assert.match(html,/same captured membership and version-set IDs as \/queue/);assert.match(html,/Completed attempts are history/);
 assert.match(code,/aria-expanded/);assert.match(code,/aria-controls/);assert.match(code,/expanded\.has\(item\.id\)/);assert.match(code,/row\.dataset\.familyId/);assert.match(code,/r\.attention==='working'/);assert.match(code,/r\.attempts\.flatMap/);assert.match(code,/item\.attemptsTruncated/);assert.match(code,/r\.attempts\.length<=40/);
});
test('dynamic client only reads, validates bounded data, renders text and preserves stale evidence on failure',()=>{
 const code=queueStatusClientScript().replace(/^<script>|<\/script>$/gu,'');assert.doesNotThrow(()=>new Script(code));
 assert.match(code,/method:'GET'/);assert.match(code,/cache:'no-store'/);assert.match(code,/setTimeout\(poll,10000\)/);assert.match(code,/setTimeout\(\(\)=>controller.abort\(\),12000\)/);
 assert.match(code,/rows.length<=500/);assert.match(code,/node.textContent=String\(value\)/);assert.match(code,/table shows the last successful snapshot, not current status/);
 assert.match(code,/document.hidden/);assert.match(code,/request\?\.abort\(\)/);assert.match(code,/if\(current!==generation\)return/);
 assert.doesNotMatch(code,/method:'POST'|innerHTML|insertAdjacentHTML|approveAndExecute|queue-action|execFile|window\.location\.reload/);
});
test('queue total is independent of history and acceptance views and exposes shared snapshot age',()=>{
 const html=renderQueueStatusHtml(),code=queueStatusClientScript();assert.match(html,/value="queue">Current queue/);assert.match(html,/value="acceptance">Acceptance review · separate/);assert.match(html,/value="history">History · separate/);assert.match(html,/History and acceptance-review entries are separate/);
 assert.match(code,/const queueContext=data.rows.filter\(matches\)/);assert.match(code,/count-total'\).textContent=String\(queueContext.length\)/);assert.match(code,/count-review'\).textContent=String\(data.acceptanceReviewRows.filter\(matches\).length\)/);assert.match(code,/count-history'\).textContent=String\(data.historyRows.filter\(matches\).length\)/);assert.match(code,/report.queueSnapshot.capturedAt/);assert.match(code,/report.queueSnapshot.ageMs/);assert.match(code,/report.queueSnapshot.refreshing/);
});
test('dashboard serves a no-store local GET surface and refuses mutations or malformed scope',()=>{
 const code=readFileSync(new URL('../commands/daemon.ts',import.meta.url),'utf8'),start=code.indexOf('requestUrl.pathname === "/queue-status"'),end=code.indexOf('requestUrl.pathname === "/api/queue-partner-activity"',start),route=code.slice(start,end);
 assert.ok(start>0&&end>start);assert.match(route,/request.method !== "GET"/);assert.match(route,/isTrustedLocalDashboardRequest/);assert.match(route,/parseQueueStatusProject/);assert.match(route,/\["partner", "all"\]/);assert.match(route,/"cache-control": "no-store"/);assert.match(route,/503/);assert.doesNotMatch(route,/runWorkerOnce|recordRunAction|approveAndExecute|replayWorkflow/);
 assert.match(route,/loadQueueCardSnapshot\(undefined\)/);assert.match(route,/items: snapshot.value.queue/);assert.match(route,/queueSnapshotHeaders\(snapshot\)/);assert.doesNotMatch(route,/listWorkflowQueue\(/);
});
