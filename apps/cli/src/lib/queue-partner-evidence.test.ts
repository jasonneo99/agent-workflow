import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {proposePartnerEvidence,recoverOriginalRouteEvidence,discoverableScopeObservation,type PartnerEvidenceInput} from './queue-partner-evidence.js';
const fixture=():PartnerEvidenceInput=>({sourceRunId:'original',projectId:'child',runSetId:'family',root:'/synthetic/parent/child',canonical:true,status:'blocked',task:'All original requirements including native acceptance.',taskHash:acceptanceDigest('All original requirements including native acceptance.'),receiptChainVerified:true,metadata:{},scopeEvidence:[{reference:'receipt:original-write',runId:'original',projectId:'child',chainVerified:true,kind:'file-write',sourcePaths:['src/main.ts']}],routeEvidence:[]});
test('hidden governed receipt writes are recovered, not hidden policy/context or credential reads',()=>{
 assert.equal(discoverableScopeObservation('file_write','.agent-workflow/receipts/synthetic-repair.md'),true);
 assert.equal(discoverableScopeObservation('file_read','.agent-workflow/receipts/synthetic-repair.md'),false);
 for(const target of ['.agent-workflow/project.yaml','.agent-workflow/context.md','.agent-workflow/.env','.agent-workflow/receipts/../project.yaml','.agent-workflow/receipts/secrets/fixture.md','vendor/product/file.ts','/synthetic/root/src/main.ts','src/.env','src/*.ts'])
  assert.equal(discoverableScopeObservation('file_write',target),false,target);
 assert.equal(discoverableScopeObservation('file_write','src/main.ts'),true);
 assert.equal(discoverableScopeObservation('file_read','docs/contract.md'),true);
 assert.equal(discoverableScopeObservation('untrusted_action','src/main.ts'),false);
 const f=fixture();f.scopeEvidence.push({...f.scopeEvidence[0]!,sourcePaths:['.agent-workflow/receipts/synthetic-repair.md']});
 const proposal=proposePartnerEvidence(f);assert.equal(proposal.state,'proposed');
 if(proposal.state==='proposed'){assert.equal(proposal.proposal.authority,'none');assert.equal(proposal.proposal.requiresCurrentAuthorization,true);}
});
test('authentic original route observations improve evidence without becoming approval or route authority',()=>{
 const context={sourceRunId:'original',projectId:'child',chainVerified:true};
 const record={reference:'a'.repeat(64),runId:'original',projectId:'child',metadata:{route:{providerId:'synthetic-provider',modelTier:'standard'},actualProviderId:'synthetic-provider'}};
 const routes=recoverOriginalRouteEvidence(context,[record]);assert.equal(routes.length,1);
 const proposal=proposePartnerEvidence({...fixture(),routeEvidence:routes});assert.equal(proposal.state,'proposed');
 if(proposal.state==='proposed'){assert.equal(proposal.proposal.historicalRoute?.provider,'synthetic-provider');assert.equal(proposal.proposal.authority,'none');assert.equal(proposal.proposal.requiresCurrentAuthorization,true);}
 for(const changed of [{...record,runId:'foreign'},{...record,projectId:'parent'},{...record,reference:'unverified'},
  {...record,metadata:{...record.metadata,actualProviderId:'fallback-provider'}},
  {...record,metadata:{route:{providerId:'synthetic-provider',modelTier:'unknown'},actualProviderId:'synthetic-provider'}}])assert.deepEqual(recoverOriginalRouteEvidence(context,[changed]),[]);
 assert.deepEqual(recoverOriginalRouteEvidence({...context,chainVerified:false},[record]),[]);
 assert.deepEqual(recoverOriginalRouteEvidence(context,Array(1001).fill(record)),[]);
});
test('proposal preserves requirements and observation provenance but grants no authority or historical preimage',()=>{
  const f=fixture(),before=JSON.stringify(f),r=proposePartnerEvidence(f);assert.equal(r.state,'proposed');if(r.state!=='proposed')return;
  assert.equal(JSON.stringify(f),before);assert.equal(r.proposal.originalRequirements,f.task);assert.equal(r.proposal.authority,'none');assert.equal(r.proposal.requiresCurrentAuthorization,true);assert.equal(r.proposal.baselineMode,'new-current-baseline');assert.equal(r.proposal.historicalRoute,null);assert.deepEqual(r.proposal.sourcePaths,['src/main.ts']);
});
test('explicit original manifest wins over incidental governed reads without expanding scope',()=>{
  const f=fixture();f.scopeEvidence.push({...f.scopeEvidence[0]!,kind:'task-source-manifest',reference:'artifact:manifest',sourcePaths:['src/exact.ts']});const r=proposePartnerEvidence(f);assert.equal(r.state,'proposed');if(r.state==='proposed'){assert.deepEqual(r.proposal.sourcePaths,['src/exact.ts']);assert.equal(r.proposal.scopeBasis,'explicit-original-manifest');}
});
test('full identity, task, canonical, terminal, evaluation and child guards fail closed',()=>{
  const changes:Array<(f:PartnerEvidenceInput)=>void>=[f=>{f.canonical=false;},f=>{f.task='changed';},f=>{f.receiptChainVerified=false;},f=>{f.status='running';},f=>{f.status='cancelled';},f=>{f.metadata={sourceRunId:'parent'};},f=>{f.metadata={acceptanceContract:{}};},f=>{f.metadata={evaluationId:'evaluation'};},f=>{f.root='/synthetic/vendor/child';},f=>{f.scopeEvidence=[];}];
  for(const change of changes){const f=fixture();change(f);assert.equal(proposePartnerEvidence(f).state,'held');}
});
test('parent ownership never transfers evidence; unsafe paths and conflicting manifests refuse',()=>{
  for(const patch of [{projectId:'parent'},{runId:'other'},{chainVerified:false},{sourcePaths:['../escape']},{sourcePaths:['vendor/child/file.ts']},{sourcePaths:['.env']},{sourcePaths:['src/*.ts']}]){const f=fixture();Object.assign(f.scopeEvidence[0]!,patch);assert.equal(proposePartnerEvidence(f).state,'held');}
  const f=fixture();f.scopeEvidence=[{...f.scopeEvidence[0]!,kind:'task-source-manifest'}, {...f.scopeEvidence[0]!,kind:'acceptance-requirements',sourcePaths:['different.ts']}];assert.equal(proposePartnerEvidence(f).state,'held');
});
test('historical route remains observation, not new-baseline permission; conflicting routes refuse',()=>{
  const f=fixture();f.routeEvidence=[{reference:'receipt:route',runId:'original',projectId:'child',chainVerified:true,provider:'original-provider',modelTier:'reasoning'}];const r=proposePartnerEvidence(f);assert.equal(r.state,'proposed');if(r.state==='proposed'){assert.equal(r.proposal.historicalRoute?.provider,'original-provider');assert.equal(r.proposal.authority,'none');}
  f.routeEvidence.push({...f.routeEvidence[0]!,provider:'different-provider'});assert.equal(proposePartnerEvidence(f).state,'held');
});
