import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { dashboardPartnerChatScript } from './partner-chat-client.js';

class Element {
  children: Element[] = []; listeners = new Map<string, Function>(); dataset: any = {}; style: any = {}; parent: Element | null = null;
  value = ''; text = ''; className = ''; hidden = false; disabled = false; scrollHeight = 100; scrollTop = 0; clientHeight = 200; focused = false;
  type = ''; href = ''; target = ''; rel = ''; open = false;
  constructor(public tag = 'div') {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren() { this.text = ''; this.children = []; this.scrollTop = 0; }
  get firstElementChild() { return this.children[0]; } get lastElementChild() { return this.children.at(-1); }
  setAttribute(name: string, value: string) { (this as any)[name] = value; }
  addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
  querySelector(selector: string): Element | null { return this.children.find(child => child.className.split(' ').includes(selector.slice(1))) ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null; }
  contains(node: Element): boolean { return this === node || this.children.some(child=>child.contains(node)); }
  closest() { return { dataset: { partnerRun: '' } }; }
  focus() { this.focused = true; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  requestSubmit() { this.listeners.get('submit')?.({ preventDefault() {} }); }
  fire(name: string) { this.listeners.get(name)?.({ preventDefault() {} }); }
}
function findButton(root: Element, text: string): Element | undefined { return root.children.find(child=>child.tag==='button'&&child.textContent===text) ?? root.children.map(child=>findButton(child,text)).find(Boolean); }
const report = (text = 'Synthetic agent reply', extra = {}) => ({ kind: 'queue_partner_chat_report', status: 'answered', text, items: [], ...extra });
const response = (value: any) => ({ ok: true, json: async () => value });
const flush = async () => { await setImmediate(); await setImmediate(); };
function harness(fetcher: (body: any, options: any) => Promise<any>, cache = new Map<string, string>()) {
  const names = ['form', 'thread', 'status', 'message', 'recent', 'new', 'stop-wait', 'jump', 'storage', 'observation'];
  const elements = new Map(names.map(name => [name, new Element()]));
  const events = new Map<string, Function>();
  const document = { hidden: false, getElementById: (id: string) => elements.get(id.replace('dashboard-question-', '')), createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element('#text'), { text }), querySelectorAll: () => [], addEventListener: (name: string, fn: Function) => events.set(name, fn), dispatchEvent(event: any) { events.get(event.name)?.(event.options); } };
  new Script(dashboardPartnerChatScript().slice(8, -9)).runInNewContext({ document, window: { addEventListener() {} }, localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value) }, crypto: { randomUUID }, URL, URLSearchParams, setTimeout: () => 1, clearTimeout() {}, location: { origin: 'http://127.0.0.1:17998' }, AbortController, CustomEvent: class { constructor(public name: string, public options: any) {} }, navigator: { clipboard: { writeText: async () => {} } }, fetch: async (url: string, options: any) => { if (url.startsWith('/api/partner-work-history')) { const runId=new URL(url,'http://fixture').searchParams.get('run'); return response({version:1,authority:'evidence-only',scope:{runId,projectId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},run:{id:runId,status:'blocked'},steps:[],active:[],after:null,before:null,hasMore:false,hasOlder:false}); } return fetcher(JSON.parse(options.body), options); } });
  return { elements, cache, emit: (detail: any) => events.get('queue-partner-live-snapshot')?.({detail}), emitCheck: (detail:any)=>events.get('queue-partner-check-observed')?.({detail}), unavailable:()=>events.get('queue-partner-activity-unavailable')?.({}), send(text: string) { elements.get('message')!.value = text; elements.get('form')!.requestSubmit(); }, snapshot() { return JSON.parse(cache.get('agentflow.partner.chats.v1:queue')!); } };
}
test('reload restores the conversation and draft without another network request', async () => {
  let calls = 0; const h = harness(async () => { calls++; return response(report()); });
  h.send('Inspect this item'); await flush();
  h.elements.get('message')!.value = 'Unsent follow-up'; h.elements.get('message')!.fire('input');
  const next = harness(async () => { calls++; return response(report()); }, h.cache);
  assert.match(next.elements.get('thread')!.textContent, /Synthetic agent reply/);
  assert.equal(next.elements.get('message')!.value, 'Unsent follow-up'); assert.equal(calls, 1);
});
test('queue-wide conversations show current updates and step trails without requiring Follow first',async()=>{
 const a=randomUUID(),b=randomUUID(),bodies:any[]=[];
 const h=harness(async body=>{bodies.push(body);return response(report('Queue summary'));});
 h.send('status?');await flush();
 const update={authority:'evidence-only',entries:[a,b].map((runId,index)=>({runId,title:'Queue item '+index,what:'Checking recorded evidence '+index,next:'Preserve the exact gate',state:'blocked'}))};
 h.emit(update);h.emit(update);await flush();
 const chat=h.snapshot().threads[0];assert.equal(chat.selectedRunId,null,'A read-only observation must not silently select an action target');
 assert.equal(chat.turns.filter((turn:any)=>turn.observation).length,2);assert.equal(chat.workRefs.length,2);
 assert.match(h.elements.get('thread')!.textContent,/Checking recorded evidence 0/);
 assert.match(h.elements.get('thread')!.textContent,/recorded steps/);
 h.send('Explain the queue');await flush();assert.equal(bodies.at(-1).runId,undefined);
 assert.ok(bodies.at(-1).history.every((turn:any)=>!turn.content.includes('Checking recorded evidence')));
});

test('selected-item chats do not ingest unrelated queue work',async()=>{
 const a=randomUUID(),b=randomUUID(),h=harness(async()=>response(report('Following one item',{selectedRunId:a,runId:a})));
 h.send('Follow this item');await flush();
 h.emit({authority:'evidence-only',entries:[{runId:b,title:'Unrelated item',what:'Must stay out of selected work',state:'running'}]});
 assert.doesNotMatch(h.elements.get('thread')!.textContent,/Must stay out/);assert.equal(h.snapshot().threads[0].selectedRunId,a);
});

test('completed check times, stale checks and connection failures remain separate from chat replies and work authority',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return response(report());});
 const coordinator={version:1,authority:'evidence-only',checkedAt:new Date().toISOString(),inventory:4,held:4,stale:false};
 h.emitCheck({authority:'evidence-only',coordinator});
 assert.match(h.elements.get('observation')!.textContent,/Last queue check.*4 items.*4 held/);assert.equal(h.snapshot().threads[0].turns.length,0);assert.equal(calls,0);
 h.emitCheck({authority:'evidence-only',coordinator:{...coordinator,checkedAt:new Date(Date.now()-60000).toISOString()}});
 assert.match(h.elements.get('observation')!.textContent,/No recent coordinator check/);
 h.unavailable();assert.match(h.elements.get('observation')!.textContent,/Live queue updates unavailable.*Last check/);
 h.emitCheck({authority:'evidence-only',coordinator:null});assert.match(h.elements.get('observation')!.textContent,/no completed Partner check recorded/);
 h.emitCheck({authority:'evidence-only',coordinator:{...coordinator,checkedAt:new Date(Date.now()+60000).toISOString()}});assert.match(h.elements.get('observation')!.textContent,/no completed Partner check/);
 assert.equal(findButton(h.elements.get('thread')!,'Approve and run this exact action'),undefined);assert.equal(calls,0);
});

test('follow-ups queue behind a pending reply and carry the actual settled dialogue', async () => {
  let resolve!: (value: any) => void; const bodies: any[] = [];
  const h = harness(async body => { bodies.push(body); return bodies.length === 1 ? new Promise(r => { resolve = r; }) : response(report('Follow-up answer')); });
  h.send('First question'); h.send('Then check the next step');
  assert.equal(bodies.length, 1); assert.equal(h.elements.get('message')!.disabled, false);
  resolve(response(report('First answer'))); await flush();
  assert.equal(bodies.length, 2); assert.equal(bodies[1].message, 'Then check the next step');
  assert.deepEqual(bodies[1].history.map((turn: any) => turn.content), ['First question', 'First answer']);
});
test('uncertain requests do not auto-retry or flush queued actions; manual retry reuses the exact request', async () => {
  const bodies: any[] = []; let reject!: (error: Error) => void;
  const h = harness(async body => { bodies.push(body); return bodies.length === 1 ? new Promise((_r, j) => { reject = j; }) : response(report('Recorded result', { replayed: true })); });
  h.send('First question'); h.send('Fix it'); reject(Error('network lost')); await flush();
  assert.equal(bodies.length, 1); assert.match(h.elements.get('status')!.textContent, /unconfirmed/);
  const retry = h.elements.get('thread')!.lastElementChild!.children.find(child => child.textContent === 'Retry the same message')!;
  retry.fire('click'); await flush(); assert.equal(bodies.length, 2); assert.deepEqual(bodies[1], bodies[0]);
  assert.match(h.elements.get('thread')!.textContent, /not executed again/);
});
test('Stop waiting aborts transport and ignores a late reply without claiming to cancel work', async () => {
  let resolve!: (value: any) => void, signal!: AbortSignal;
  const h = harness(async (_body, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); });
  h.send('Slow question'); h.elements.get('stop-wait')!.fire('click');
  assert.equal(signal.aborted, true); assert.match(h.elements.get('thread')!.textContent, /may still finish/);
  resolve(response(report('Late reply must not appear'))); await flush();
  assert.doesNotMatch(h.elements.get('thread')!.textContent, /Late reply must not appear/);
});
test('an incoming reply preserves the reading position when the operator scrolls into history', async () => {
  let resolve!: (value: any) => void;
  const h = harness(async () => new Promise(r => { resolve = r; }));
  h.send('A longer question');
  const log = h.elements.get('thread')!; log.scrollHeight = 1000; log.clientHeight = 100; log.scrollTop = 150;
  resolve(response(report('A later agent reply'))); await flush();
  assert.equal(log.scrollTop, 150); assert.equal(h.elements.get('jump')!.hidden, false);
  h.elements.get('jump')!.fire('click'); assert.equal(log.scrollTop, 1000);
});
test('new chats isolate conversation identity, selection and proposal, and recent chats restore drafts', async () => {
  const h = harness(async () => response(report())); h.send('First conversation'); await flush();
  const first = h.snapshot().activeId; h.elements.get('message')!.value = 'First draft'; h.elements.get('message')!.fire('input');
  h.elements.get('new')!.fire('click'); assert.notEqual(h.snapshot().activeId, first); assert.equal(h.elements.get('message')!.value, '');
  h.elements.get('recent')!.value = first; h.elements.get('recent')!.fire('change'); assert.equal(h.elements.get('message')!.value, 'First draft');
});
test('inline approval only sends the exact displayed unexpired conversation and run proposal', async () => {
  const runId = randomUUID(), proposalId = randomUUID(), bodies: any[] = [];
  const h = harness(async body => { bodies.push(body); return response(report('Exact action needs a decision', { status: 'needs-approval', selectedRunId: runId, proposal: { id: proposalId, conversationId: body.conversationId, runId, disclosure: 'Synthetic complete action payload', expiresAt: new Date(Date.now() + 60000).toISOString() } })); });
  h.send('Fix it'); await flush(); assert.equal(Boolean(findButton(h.elements.get('thread')!, 'Approve and run this exact action')), true);
  assert.match(h.elements.get('thread')!.textContent, /Synthetic complete action payload/);
  findButton(h.elements.get('thread')!, 'Approve and run this exact action')!.fire('click'); await flush();
  assert.equal(bodies[1].proposalId, proposalId); assert.equal(bodies[1].runId, runId); assert.equal(bodies[1].conversationId, bodies[0].conversationId);
});
test('restoring a transcript cannot reactivate its cached approval or attach it to a new message', async () => {
  const runId = randomUUID(), proposalId = randomUUID(), bodies: any[] = [];
  const h = harness(async body => response(report('Review the exact action', { status: 'needs-approval', selectedRunId: runId, proposal: { id: proposalId, conversationId: body.conversationId, runId, disclosure: 'Complete synthetic action', expiresAt: new Date(Date.now() + 60000).toISOString() } })));
  h.send('Fix it'); await flush();
  const restored = harness(async body => { bodies.push(body); return response(report()); }, h.cache);
  assert.match(restored.elements.get('thread')!.textContent, /Complete synthetic action/);
  assert.equal(findButton(restored.elements.get('thread')!, 'Approve and run this exact action'), undefined);
  restored.send('Approved'); await flush(); assert.equal(bodies[0].proposalId, undefined);
});
test('trimming the displayed action also removes inline consent from subsequent requests', async () => {
  const runId = randomUUID(), proposalId = randomUUID(), bodies: any[] = [];
  const h = harness(async body => {
    bodies.push(body);
    return response(body.message === 'Fix it' ? report('Exact decision', { status: 'needs-approval', selectedRunId: runId, proposal: { id: proposalId, conversationId: body.conversationId, runId, disclosure: 'Complete synthetic action', expiresAt: new Date(Date.now() + 60000).toISOString() } }) : report('Further discussion'));
  });
  h.send('Fix it'); await flush();
  for (let i = 0; i < 25; i++) { h.send('Discuss step ' + i); await flush(); }
  assert.equal(findButton(h.elements.get('thread')!, 'Approve and run this exact action'), undefined);
  h.send('Approved'); await flush(); assert.equal(bodies.at(-1).proposalId, undefined);
});
test('a late response cannot steal a newer item selection or expose its old proposal', async () => {
  const a = randomUUID(), b = randomUUID(); let resolve!: (value: any) => void; let count = 0;
  const items = [{ runId: a, title: 'Item Alpha', status: 'running' }, { runId: b, title: 'Item Beta', status: 'running' }];
  const h = harness(async () => ++count === 1 ? response(report('Choose work', { items, selectedRunId: a })) : new Promise(r => { resolve = r; }));
  h.send('List items'); await flush(); h.send('Explain this item');
  findButton(h.elements.get('thread')!, 'Follow: Item Beta')!.fire('click');
  resolve(response(report('Old item response', { selectedRunId: a }))); await flush();
  assert.equal(h.snapshot().threads[0].selectedRunId, b);
});

test('useful live updates appear inline once, retain their next step, and do not become conversation instructions',async()=>{
  const runId=randomUUID(),bodies:any[]=[];
  const h=harness(async body=>{bodies.push(body);return response(report('Following the selected work',{selectedRunId:runId,runId}));});
  h.send('Follow the work');await flush();
  const update={authority:'evidence-only',entries:[{runId,title:'Review needs input',what:'Verification evidence is missing.',why:'A required case did not run.',how:'Keep the existing evidence.',next:'Review the exact verification request.',requiresPermission:true,state:'blocked'}]};
  h.emit(update);h.emit(update);
  assert.equal(h.snapshot().threads[0].turns.filter((turn:any)=>turn.observation).length,1);
  assert.match(h.elements.get('thread')!.textContent,/Next: Review the exact verification request/);
  assert.match(h.elements.get('thread')!.textContent,/Your approval is needed/);
  assert.equal(findButton(h.elements.get('thread')!,'Approve and run this exact action'),undefined);
  h.send('Explain the next step');await flush();assert.ok(bodies.at(-1).history.every((turn:any)=>!turn.content.includes('Verification evidence is missing')));
});
