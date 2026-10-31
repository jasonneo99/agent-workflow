import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifiedVerifierEffects,inspectVerifierReassessment} from './verifier-reassessment.js';

test('verifier observations qualify colliding relative paths by canonical project without claiming current bytes',()=>{
 const projects=[{id:'one',root_uri:'/synthetic/one'},{id:'two',root_uri:'/synthetic/two'}];
 const metadata=(id:string,root:string)=>({projectId:id,projectRoot:root,absolutePath:root+'/docs/shared.md',relativePath:'docs/shared.md',nextHash:'a'.repeat(64),existed:true,bytesWritten:2,outcome:'applied'});
 const receipts=projects.map(p=>({action_type:'file_write',target:'docs/shared.md',receipt_hash:(p.id==='one'?'b':'c').repeat(64),metadata:metadata(p.id,p.root_uri)}));
 const artifacts=receipts.map((r,i)=>({kind:'file_write',uri:'synthetic://'+i,content:r.metadata}));
 const observed=qualifiedVerifierEffects(receipts,artifacts,projects);
 assert.deepEqual(observed.map(r=>r.projectId),['one','two']);
 for(const mutate of [
  (r:any[],a:any[])=>{r[1].metadata.absolutePath='/synthetic/one/docs/shared.md';},
  (r:any[])=>{r[0].action_type='external_action';},
  (r:any[])=>{r[0].metadata.relativePath='../shared.md';},
  (r:any[])=>{delete r[0].metadata.absolutePath;},
  (r:any[],a:any[])=>{a[0].content={};},
  (r:any[],a:any[])=>{a.push({...a[0],uri:'synthetic://duplicate'});},
  (r:any[])=>{r[0].metadata.outcome='uncertain';},
 ]){const r=structuredClone(receipts),a=structuredClone(artifacts);mutate(r,a);assert.throws(()=>qualifiedVerifierEffects(r,a,projects));}
 assert.throws(()=>qualifiedVerifierEffects(receipts,artifacts,[...projects,projects[0]]));
});

test('verifier mode never admits a repair role or a terminal success before querying authority',async()=>{
 const input={runId:'synthetic',assignmentId:'claim',expectedFence:'1',owner:'owner',intentFence:'1',actor:'human',authorizationReference:'human-message:1',sourcePaths:['source.ts'],commands:['git diff --check'],verifierReassessment:{authorizationUri:'synthetic://grant'}};
 const c={query:()=>{throw Error('unexpected query');}} as any;
 await assert.rejects(inspectVerifierReassessment(c,input,{state:'held',role:'repair',prior_child:'synthetic'},{status:'failed'}),/Exact failed held verifier/);
 await assert.rejects(inspectVerifierReassessment(c,input,{state:'held',role:'verifier',prior_child:'synthetic'},{status:'completed'}),/Exact failed held verifier/);
});
