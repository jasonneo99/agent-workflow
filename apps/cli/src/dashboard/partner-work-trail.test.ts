import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { installPartnerWorkTrail, mergePartnerWorkSteps } from './partner-work-trail.js';
const run=randomUUID();
const step=(at:string,title:string)=>({id:run+':'+randomUUID(),at,title,state:'recorded',detail:'Synthetic recorded action',agent:'frontend-engineer'});
test('new steps append chronologically and reconnecting with the same event never duplicates it',()=>{
  const first=step('2026-01-01T00:00:00.100000Z','Read source'),second=step('2026-01-01T00:00:00.100001Z','Edit source');
  const result=mergePartnerWorkSteps([second],[first,second],run);assert.deepEqual(result.map(s=>s.title),['Read source','Edit source']);assert.equal(result[0].at,first.at);
  assert.deepEqual(mergePartnerWorkSteps(result,[first,second],run),result);
});
test('history rejects foreign or malformed events, retains failures, and bounds long conversations',()=>{
  const failure={...step('2026-01-01T00:00:00Z','Check failed'),state:'failed'};
  const result=mergePartnerWorkSteps([],[failure,{...failure,id:randomUUID()+':'+randomUUID()},{...failure,id:run+':invalid'},{...failure,at:'bad'}],run);
  assert.equal(result.length,1);assert.equal(result[0].state,'failed');
  const long=Array.from({length:450},(_,i)=>step(new Date(i*1000).toISOString(),String(i)));
  assert.equal(mergePartnerWorkSteps([],long,run).length,400);
  assert.equal(mergePartnerWorkSteps([],long,run)[0].title,'50');
});

test('a live reader retains steps during an outage and resumes once without losing expanded details',async()=>{
  class Element {
    children:Element[]=[];listeners=new Map<string,Function>();dataset:any={};className='';text='';open=false;hidden=false;isConnected=true;scrollTop=0;scrollHeight=100;clientHeight=100;
    constructor(public tag='div'){} get textContent():string{return this.text+this.children.map(e=>e.textContent).join('')}set textContent(v:string){this.text=v;this.children=[]}
    append(...children:Element[]){this.children.push(...children)}replaceChildren(){this.children=[];this.text=''}setAttribute(){}focus(){}contains(){return false}
    addEventListener(name:string,fn:Function){this.listeners.set(name,fn)}
    querySelector(selector:string):Element|null{return this.children.find(e=>e.className===selector.slice(1))??this.children.map(e=>e.querySelector(selector)).find(Boolean)??null}
  }
  const host=new Element(),panel=new Element(),timers=new Map<number,{fn:()=>unknown;delay:number}>(),documentEvents=new Map<string,Function>();let timerId=0,calls=0;
  const first=step('2026-01-01T00:00:00.100Z','Read source'),second=step('2026-01-01T00:00:01.000Z','Check finished');
  let payload={version:1,authority:'evidence-only',scope:{runId:run,projectId:randomUUID()},run:{id:run,status:'running'},steps:[first],active:[{agent:'frontend-engineer',leaseExpiresAt:new Date(Date.now()+3600000).toISOString()}],after:first.at+'|'+first.id.split(':')[1],before:first.at+'|'+first.id.split(':')[1],hasMore:false,hasOlder:false};
  const document={hidden:false,activeElement:null,getElementById:()=>panel,createElement:(tag:string)=>new Element(tag),addEventListener:(name:string,fn:Function)=>documentEvents.set(name,fn)};
  const mount=new Script(`const __name=fn=>fn;(${installPartnerWorkTrail.toString()})(${mergePartnerWorkSteps.toString()},()=>{})`).runInNewContext({document,window:{addEventListener(){}},URLSearchParams,AbortController,fetch:async()=>{calls++;if(calls===2)throw Error('Synthetic outage');return{ok:true,json:async()=>payload}},setTimeout:(fn:()=>unknown,delay:number)=>{timers.set(++timerId,{fn,delay});return timerId},clearTimeout:(id:number)=>timers.delete(id)});
  const flush=async()=>{await setImmediate();await setImmediate()};
  const tick=async()=>{const entry=[...timers].find(([,timer])=>timer.delay<12000)!;assert.ok(entry);timers.delete(entry[0]);entry[1].fn();await flush()};
  mount(run,host);await flush();assert.match(host.textContent,/Frontend Engineer is working/);assert.equal(calls,1);
  const disclosure=host.children[0].children[1].children[0].children[0];disclosure.open=true;disclosure.listeners.get('toggle')!();
  await tick();assert.match(host.textContent,/Live updates unavailable/);assert.match(host.textContent,/Read source/);
  payload={...payload,steps:[first,second],after:second.at+'|'+second.id.split(':')[1]};await tick();assert.match(host.textContent,/Check finished/);assert.equal(host.querySelector('.partner-work-steps')!.children.length,2);
  assert.equal(host.children[0].children[1].children[0].children[0].open,true);
  const same=host.children[0];await tick();assert.equal(host.children[0],same,'Unchanged polls preserve focused controls and disclosure nodes');
  document.hidden=true;documentEvents.get('visibilitychange')!();assert.equal(timers.size,0);const count=calls;
  const restored=new Element();mount(run,restored);await flush();assert.equal(calls,count);assert.match(restored.textContent,/Check finished/);
  document.hidden=false;documentEvents.get('visibilitychange')!();await flush();assert.equal(calls,count+1);assert.equal(restored.querySelector('.partner-work-steps')!.children.length,2);
  payload={...payload,active:[{agent:'frontend-engineer',leaseExpiresAt:new Date(Date.now()-1).toISOString()}]};await tick();assert.doesNotMatch(restored.textContent,/is working/);assert.match(restored.textContent,/Waiting for recorded agent activity/);
});
