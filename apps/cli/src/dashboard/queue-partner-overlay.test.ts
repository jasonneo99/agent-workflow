import assert from 'node:assert/strict';
import test from 'node:test';
import {Script} from 'node:vm';
import {setImmediate} from 'node:timers/promises';
import {renderQueuePartnerOverlay} from './queue-partner-overlay.js';
const projects=[{id:'one',name:'Project One',rootUri:'/synthetic/one'},{id:'two',name:'Project Two',rootUri:'/synthetic/two'}];
const runId='22222222-2222-4222-8222-222222222222';
const render=(run?:string)=>renderQueuePartnerOverlay(projects,'/synthetic/one',{runId:run});
const script=(html=render())=>html.match(/<script data-queue-partner-overlay-script>([\s\S]*?)<\/script>/u)![1];
const entry=(patch:Record<string,unknown>={})=>({id:'decision-one',familyId:'family-one',runId,title:'Repairing the missing proof',state:'running',kind:'decision',what:'Checking the exact source evidence.',why:'The previous attempt omitted a required proof.',how:'An isolated read-only verifier checks the candidate.',next:'Record actual executed evidence before acceptance.',requiresPermission:false,evidence:[{label:'Run history',url:`/runs?relatedTo=${runId}`}],...patch});
const report=(entries=[entry()],patch:Record<string,unknown>={})=>({version:1,authority:'evidence-only',scope:{kind:'queue'},capacity:{repair:5,verifier:1},observedAt:'timestamp',entries,watching:['Waiting for the independent verifier; unrelated eligible families may continue.'],truncated:false,...patch});
const response=(value:unknown)=>({ok:true,json:async()=>value});

test('Partner presents one accessible chat with no legacy dashboard panels',()=>{
 const html=render(runId),markup=html.replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<script[\s\S]*?<\/script>/g,'');
 assert.match(markup,/role="dialog" aria-modal="false"/);assert.match(markup,/aria-controls="queue-partner-overlay" aria-expanded="false"/);
 assert.equal((markup.match(/id="dashboard-question-form"/g)??[]).length,1);
 assert.doesNotMatch(markup,/queue-partner-(?:activity|notices|toast)|Coordinator activity|Live feedback|ops-question-prompts/);
 assert.doesNotThrow(()=>new Script(script(html)));assert.match(html,/prefers-reduced-motion/);
 const attack=renderQueuePartnerOverlay([{id:'</script>',name:'<img src=x onerror=alert(1)>',rootUri:'/synthetic/one'}],'/synthetic/one',{runId:'</script>'});assert.doesNotMatch(attack,/<img/);
});
test('queue activity is a bounded read-only feed into the conversation',async()=>{
 const source=script();assert.match(source,/\/api\/queue-partner-activity\?scope=queue/);assert.match(source,/method:'GET'/);assert.match(source,/12000/);
 assert.doesNotMatch(source,/server-conversation|\/api\/queue-action|approveAndExecute|innerHTML|insertAdjacentHTML/);
 const h=harness(async()=>response(report([entry({what:'token=private Observation'})])));await h.flush();
 const event=h.events.find(e=>e.type==='queue-partner-live-snapshot');assert.ok(event);const item=event.detail.detail.entries[0];
 assert.match(item.what,/Observation/);assert.doesNotMatch(item.what,/private/);assert.match(item.why,/previous attempt/);assert.match(item.how,/isolated read-only/);assert.match(item.next,/actual executed evidence/);
 assert.equal(h.elements.get('dashboard-question-message')!.focused,false);
});
test('timestamps do not duplicate updates; meaningful changes light the unread marker',async()=>{
 let value=report();const h=harness(async()=>response(value));await h.flush();const count=()=>h.events.filter(event=>event.type==='queue-partner-live-snapshot').length,initial=count();
 value={...value,observedAt:'another timestamp'};h.timers.at(-1)!();await h.flush();assert.equal(count(),initial);
 value=report([entry({next:'New exact blocker'})]);h.timers.at(-1)!();await h.flush();assert.equal(count(),initial+1);assert.equal(h.elements.get('queue-partner-unread')!.hidden,false);
 h.elements.get('queue-partner-toggle')!.listeners.get('click')!();assert.equal(h.doc.documentElement.dataset.queuePartnerOpen,'true');assert.equal(h.elements.get('dashboard-question-message')!.focused,true);assert.equal(h.elements.get('queue-partner-unread')!.hidden,true);
 h.elements.get('queue-partner-overlay')!.listeners.get('keydown')!({key:'Escape',preventDefault(){}});assert.equal(h.restore.focused,true);assert.equal(h.doc.documentElement.dataset.queuePartnerOpen,undefined);
});
test('fresh coordinator checks reach the status line even when all item states are unchanged',async()=>{
 let value:any=report(undefined,{coordinator:{version:1,authority:'evidence-only',checkedAt:'2026-01-01T00:00:00Z',inventory:3,held:3,stale:false}});
 const h=harness(async()=>response(value));await h.flush();
 const snapshots=()=>h.events.filter(e=>e.type==='queue-partner-live-snapshot').length,initial=snapshots();
 value={...value,coordinator:{...value.coordinator,checkedAt:'2026-01-01T00:00:05Z'}};h.timers.at(-1)!();await h.flush();
 assert.equal(snapshots(),initial);assert.equal(h.events.filter(e=>e.type==='queue-partner-check-observed').length,2);
 assert.equal(h.events.at(-1).detail.detail.coordinator.checkedAt,value.coordinator.checkedAt);
 assert.equal(h.elements.get('queue-partner-unread')!.hidden,true,'Check timestamps do not fabricate unread work updates');
});
test('run-page history rejects foreign scope and preserves the exact context URL',async()=>{
 let value:any=report(undefined,{scope:{rootUri:'/synthetic/one',runId:randomForeignRun}});const h=harness(async()=>response(value),runId);await h.flush();assert.equal(h.events.some(e=>e.type==='queue-partner-live-snapshot'),false);
 assert.equal(h.events.at(-1).type,'queue-partner-activity-unavailable');
 value=report(undefined,{scope:{rootUri:'/synthetic/one',runId}});h.timers.at(-1)!();await h.flush();assert.equal(h.events.at(-1).type,'queue-partner-live-snapshot');
 assert.ok(h.urls.every(url=>url===`/api/queue-partner-activity?project=%2Fsynthetic%2Fone&run=${runId}`));
});
const randomForeignRun='33333333-3333-4333-8333-333333333333';
test('visibility changes fence stale responses and pagehide stops further polling',async()=>{
 let resolveOld!:(value:unknown)=>void,calls=0;const h=harness(async()=>++calls===1?new Promise(resolve=>{resolveOld=resolve}):response(report([entry({title:'Current observation'})])));
 h.doc.hidden=true;h.documentListeners.get('visibilitychange')!();assert.equal(h.signals[0].aborted,true);h.doc.hidden=false;h.documentListeners.get('visibilitychange')!();await h.flush();
 resolveOld(response(report([entry({title:'STALE_SENTINEL'})])));await h.flush();assert.doesNotMatch(JSON.stringify(h.events),/STALE_SENTINEL/);
 const before=calls;h.windowListeners.get('pagehide')!();h.timers.at(-1)!();await h.flush();assert.equal(calls,before);
});
test('a hung activity read times out and can reconnect without executing work',async()=>{
 let calls=0;const h=harness(async(_url,options)=>++calls>1?response(report()):new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timeout')))));
 h.timers[0]();await h.flush();assert.equal(h.signals[0].aborted,true);assert.equal(h.events.at(-1).type,'queue-partner-activity-unavailable');h.timers.at(-1)!();await h.flush();assert.equal(calls,2);assert.equal(h.events.at(-1).type,'queue-partner-live-snapshot');
});

class Element {
 hidden=false;value='one';isConnected=true;children:Element[]=[];parent:Element|null=null;listeners=new Map<string,Function>();attributes=new Map<string,string>();dataset:Record<string,string>={};focused=false;className='';href='';dateTime='';private ownText='';
 selectedOptions=[{dataset:{queueUrl:'/queue?project=%2Fsynthetic%2Fone'}}];
 get textContent():string{return this.ownText+this.children.map(child=>child.textContent).join('')}
 set textContent(value:string){this.ownText=value;this.children=[]}
 addEventListener(name:string,fn:Function){this.listeners.set(name,fn)}setAttribute(name:string,value:string){this.attributes.set(name,value)}
 prepend(item:Element){item.parent=this;this.children.unshift(item)}append(...items:Element[]){for(const item of items){item.parent=this;this.children.push(item)}}
 get lastElementChild(){return this.children.at(-1)!}remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this)}replaceChildren(){this.children=[];this.ownText=''}focus(){this.focused=true}
}
function harness(fetcher:(url:string,options:any)=>Promise<any>,contextRun?:string){
 const ids=['queue-partner-toggle','queue-partner-overlay','queue-partner-close','queue-partner-unread','dashboard-question-message'];
 const elements=new Map(ids.map(id=>[id,new Element()]));elements.get('queue-partner-overlay')!.hidden=true;elements.get('queue-partner-unread')!.hidden=true;
 const documentListeners=new Map<string,Function>(),windowListeners=new Map<string,Function>(),timers:Array<()=>unknown>=[],restore=new Element();
 const doc={hidden:false,activeElement:restore,documentElement:{dataset:{} as Record<string,string>},getElementById:(id:string)=>elements.get(id),createElement:()=>new Element(),addEventListener:(name:string,fn:Function)=>documentListeners.set(name,fn)};
 const signals:AbortSignal[]=[],urls:string[]=[],events:any[]=[];Object.assign(doc,{dispatchEvent:(event:any)=>events.push(event)});
 new Script(script(render(contextRun))).runInNewContext({document:doc,window:{addEventListener:(name:string,fn:Function)=>windowListeners.set(name,fn)},location:{origin:'http://127.0.0.1:17888'},URL,AbortController,CustomEvent:class{constructor(public type:string,public detail:any){}},
  fetch:async(url:string,options:any)=>{urls.push(url);signals.push(options.signal);return fetcher(url,options)},setTimeout:(fn:()=>unknown)=>{timers.push(fn);return timers.length},clearTimeout:()=>{}});
 return {elements,events,doc,documentListeners,windowListeners,timers,signals,urls,restore,flush:()=>setImmediate()};
}
