import test from 'node:test';
import assert from 'node:assert/strict';
import {orderPartnerRecoveryRows,nextPartnerProposalId,nextPartnerEnrollmentId} from './queue-recovery-traversal.js';
const row=(id:string,authorized=false)=>({id,authorization:authorized?{authorizationId:`exact-${id}`} :null});
test('exact authorizations retain independent priority despite proposal cursor and per-pass enrollment budget',()=>{
 const rows=[row('a',true),row('b',true),row('c',true),row('d',true),...Array.from({length:8},(_,n)=>row(`proposal-${n}`))],before=JSON.stringify(rows);
 for(const cursor of ['proposal-7','missing',null])assert.deepEqual(orderPartnerRecoveryRows(rows,cursor,17).slice(0,4).map(r=>r.id),['a','b','c','d']);
 assert.equal(JSON.stringify(rows),before);
});
test('a failed authorized first batch cannot starve later exact authorizations',()=>{
 const rows=[row('a',true),row('b',true),row('c',true),row('d',true),row('e',true),row('proposal')];
 let cursor:string|null=null;const seen:string[]=[];
 for(let pass=0;pass<2;pass++)for(const attempted of orderPartnerRecoveryRows(rows,'proposal',0,cursor).filter(r=>r.authorization).slice(0,3)){seen.push(attempted.id);cursor=nextPartnerEnrollmentId(rows,attempted.id);}
 assert.deepEqual(seen,['a','b','c','d','e','a']);
 assert.ok(orderPartnerRecoveryRows(rows,null,2,'d').slice(0,5).every(r=>r.authorization));
});
test('proposal-only cursor advances fairly without counting authorized rows or changing authority',()=>{
 const rows=[row('authorized',true),row('a'),row('b'),row('c'),row('d')];let cursor:string|null='a';const seen:string[]=[];
 for(let pass=0;pass<4;pass++){const proposal=orderPartnerRecoveryRows(rows,cursor).find(r=>!r.authorization)!;seen.push(proposal.id);cursor=nextPartnerProposalId(rows,proposal.id);}
 assert.deepEqual(seen,['a','b','c','d']);assert.equal(cursor,'a');assert.equal(nextPartnerProposalId(rows,'authorized'),null);
});
test('fresh bounded processes can rotate an observation-only startup offset rather than always first rows',()=>{
 const rows=[row('authorized',true),row('a'),row('b'),row('c'),row('d')];
 assert.deepEqual([0,1,2,3].map(offset=>orderPartnerRecoveryRows(rows,null,offset)[1]!.id),['a','b','c','d']);
 assert.deepEqual(orderPartnerRecoveryRows(rows,'c',999).map(r=>r.id),['authorized','c','d','a','b']);
 assert.deepEqual(orderPartnerRecoveryRows([],null),[]);
 assert.throws(()=>orderPartnerRecoveryRows([row('same'),row('same')],null));
 assert.throws(()=>orderPartnerRecoveryRows(rows,null,-1));
 assert.throws(()=>orderPartnerRecoveryRows(Array.from({length:1001},(_,n)=>row(String(n))),null));
});
