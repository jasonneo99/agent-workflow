import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {readFileSync} from 'node:fs';
import {queueCardActivityScript,renderQueueCardActivityLine} from './queue-card-activity.js';
test('status changes replace only the current-action subtitle value without markup, card reload or history mutation',()=>{
 const subtitle={title:''},line={dataset:{queueActivity:'one'},textContent:'Old',closest:()=>subtitle};const sandbox:any={document:{querySelectorAll:()=>[line]}};
 new Script(queueCardActivityScript()).runInNewContext(sandbox);
 sandbox.updateQueueCardActivity([{runId:'foreign',liveActivity:{text:'Wrong'}},{runId:'one',liveActivity:{text:'Changed src/a.ts'}}]);assert.equal(line.textContent,'Changed src/a.ts');assert.equal(subtitle.title,'Changed src/a.ts');
 sandbox.updateQueueCardActivity([{runId:'one',liveActivity:{text:'<img onerror=attack>\nPassed checks'}}]);assert.equal(line.textContent,'<img onerror=attack> Passed checks');
 assert.doesNotMatch(queueCardActivityScript(),/innerHTML|fetch\(|reload\(|appendChild/);
});
test('rendered card has exactly one accessible bounded line and worker updates it in place',()=>{
 const source=readFileSync(new URL('../commands/daemon.ts',import.meta.url),'utf8');
 const line=renderQueueCardActivityLine('run','<img onerror=attack>');
 assert.equal((line.match(/data-queue-activity=/gu)??[]).length,1);
 assert.match(line,/white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
 assert.match(line,/aria-live="polite" aria-atomic="true"/);
 assert.match(line,/<strong>Current action<\/strong> · <span data-queue-activity="run">/);
 assert.doesNotMatch(line,/<img/);assert.match(source,/renderQueueCardActivityLine\(item.runId/);
 assert.match(source,/updateQueueCardActivity\(event.data.activities\)/);
});
