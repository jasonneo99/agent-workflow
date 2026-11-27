import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withClient} from '../../../../packages/storage/src/client.js';
import {queueDecisionReadSql} from './queue-status.js';

test('family-local history selects newest exact receipted evidence and rejects forged or foreign observations',async()=>withClient(async c=>{
 await c.query('begin');
 try{
  await c.query(`create temporary table workflow_runs(id uuid,project_id uuid,run_set_id uuid);
   create temporary table artifacts(run_id uuid,kind text,content jsonb,created_at timestamptz,uri text);
   create temporary table action_receipts(run_id uuid,agent_id text,action_type text,target text,metadata_serialization_version int,metadata jsonb);`);
  const project=randomUUID(),run=randomUUID(),set=randomUUID(),foreign=randomUUID();
  await c.query('insert into workflow_runs values($1,$2,$3),($4,$2,$3)',[run,project,set,foreign]);
  const content=(id:string,label:string)=>({version:1,authority:'evidence-only',projectId:project,runId:id,familyId:project+':'+set,decision:label});
  const add=async(id:string,label:string,second:number,receipt:boolean)=>{
   const value=content(id,label);
   await c.query("insert into artifacts values($1,'queue_partner_decision',$2,'2026-01-01T00:00:00Z'::timestamptz+($3::int*interval '1 second'),$4)",[id,value,second,label]);
   if(receipt)await c.query("insert into action_receipts values($1,'workflow-orchestrator','queue_partner_decision',$2,2,$3)",[id,project+':'+set,value]);
  };
  const read=async()=>c.query(`select decision.content from (select $2::uuid[] members) qf left join lateral(${queueDecisionReadSql}) decision on true`,[project,[run]]);
  await add(run,'older-valid',1,true);await add(run,'newer-unreceipted',2,false);await add(foreign,'foreign-member',3,true);
  assert.equal((await read()).rows[0].content.decision,'older-valid');
  await add(run,'newest-valid',4,true);
  assert.equal((await read()).rows[0].content.decision,'newest-valid');
  await c.query("update action_receipts set metadata_serialization_version=1 where metadata->>'decision'='newest-valid'");
  assert.equal((await read()).rows[0].content.decision,'older-valid');
  await c.query('delete from action_receipts');assert.equal((await read()).rows[0].content,null);
 }finally{await c.query('rollback');}
}));

// The receipt check before the indexed decisionId probe, kept verbatim as the
// reference the faster query must agree with on every family.
const referenceDecisionReadSql=`select a.content,a.created_at
 from artifacts a join workflow_runs r on r.id=a.run_id
 where a.run_id=any(qf.members) and a.kind='queue_partner_decision'
  and a.content->>'version'='1' and a.content->>'authority'='evidence-only'
  and a.content->>'projectId'=r.project_id::text and a.content->>'runId'=r.id::text
  and a.content->>'familyId'=r.project_id::text||':'||r.run_set_id::text
  and a.content->>'decision'<>'outcome' and ($1::uuid is null or r.project_id=$1::uuid)
  and exists(select 1 from action_receipts rc where rc.run_id=r.id
   and rc.agent_id='workflow-orchestrator' and rc.action_type='queue_partner_decision'
   and rc.target=r.project_id::text||':'||r.run_set_id::text
   and rc.metadata_serialization_version=2 and rc.metadata=a.content)
 order by a.created_at desc,a.uri desc limit 1`;

test('indexed decision receipt lookup selects exactly what the full JSON comparison selects',async()=>withClient(async c=>{
 let seed=20261127;
 const rand=()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};
 const pick=<T,>(items:readonly T[])=>items[Math.floor(rand()*items.length)]!;
 await c.query('begin');
 try{
  await c.query(`create temporary table workflow_runs(id uuid,project_id uuid,run_set_id uuid);
   create temporary table artifacts(run_id uuid,kind text,content jsonb,created_at timestamptz,uri text);
   create temporary table action_receipts(run_id uuid,agent_id text,action_type text,target text,metadata_serialization_version int,metadata jsonb);
   create index on artifacts(run_id,kind,created_at);
   create index on action_receipts(run_id,(metadata->>'decisionId')) where action_type='queue_partner_decision';`);
  const projects=[randomUUID(),randomUUID()],families:Array<{project:string;members:string[]}>=[];
  const runRows:object[]=[],artifactRows:object[]=[],receiptRows:object[]=[];
  const receipt=(run:string,target:string,metadata:unknown,agent='workflow-orchestrator',version=2)=>{
   receiptRows.push({run_id:run,agent_id:agent,action_type:'queue_partner_decision',target,metadata_serialization_version:version,metadata});};
  for(let f=0;f<60;f+=1){
   const project=projects[f%5===0?1:0]!,set=randomUUID(),family=`${project}:${set}`,runs=Array.from({length:1+Math.floor(rand()*4)},()=>randomUUID());
   for(const run of runs)runRows.push({id:run,project_id:project,run_set_id:set});
   for(const run of runs){
    const ids:unknown[]=[];
    for(let i=0,count=Math.floor(rand()*11);i<count;i+=1){
     // Mostly unique string ids; also legacy rows without one, numeric ids, and an id reused with different content.
     const idKind=rand(),decisionId=idKind<0.8?randomUUID():idKind<0.88?undefined:idKind<0.94?Math.floor(rand()*3):(ids.length?pick(ids):randomUUID());
     ids.push(decisionId);
     const content:Record<string,unknown>={version:rand()<0.92?1:2,authority:rand()<0.95?'evidence-only':'advisory',
      projectId:rand()<0.95?project:pick(projects),runId:rand()<0.95?run:pick(runs),familyId:rand()<0.95?family:`${project}:${randomUUID()}`,
      decision:pick(['held','active','verified','outcome','repair-selected']),semanticDigest:randomUUID(),recordedAt:`2026-01-01T00:00:${i}Z`};
     if(decisionId!==undefined)content.decisionId=decisionId;
     // Shared seconds exercise the uri tie-break.
     artifactRows.push({run_id:run,kind:'queue_partner_decision',content,created_at:new Date(Date.UTC(2026,0,1,0,0,Math.floor(rand()*40))).toISOString(),
      uri:`db://workflow_runs/${run}/queue_partner_decision/${randomUUID()}`});
     const variant=rand();
     if(variant<0.45)receipt(run,family,content);
     else if(variant<0.53){receipt(run,family,content);receipt(run,family,content);}
     else if(variant<0.61)receipt(run,family,content,'queue-partner');
     else if(variant<0.69)receipt(run,`${project}:${randomUUID()}`,content);
     else if(variant<0.75)receipt(run,family,content,'workflow-orchestrator',1);
     else if(variant<0.83)receipt(run,family,{...content,decision:'forged'});
     else if(variant<0.88)receipt(pick(runs),family,content);
    }
    // Volume: receipts for other decisions in the same family.
    for(let i=0;i<25;i+=1)receipt(run,family,{version:1,authority:'evidence-only',decisionId:randomUUID(),decision:'held'});
   }
   const foreign=families.length&&rand()<0.2?pick(families).members[0]!:undefined;
   families.push({project,members:foreign?[...runs,foreign]:runs});
  }
  for(const [table,rows] of [['workflow_runs',runRows],['artifacts',artifactRows],['action_receipts',receiptRows]] as const)
   await c.query(`insert into ${table} select * from jsonb_populate_recordset(null::${table},$1::jsonb)`,[JSON.stringify(rows)]);
  await c.query('analyze workflow_runs');await c.query('analyze artifacts');await c.query('analyze action_receipts');
  const read=async(sql:string,filter:string|null,members:string[])=>(await c.query(
   `select decision.content,decision.created_at::text as "createdAt" from (select $2::uuid[] members) qf left join lateral(${sql}) decision on true`,[filter,members])).rows[0];
  let found=0,fallback=0;
  for(const family of families)for(const filter of [null,...projects]){
   const expected=await read(referenceDecisionReadSql,filter,family.members);
   assert.deepEqual(await read(queueDecisionReadSql,filter,family.members),expected,`family ${family.members[0]} filter ${filter}`);
   if(expected?.content){found+=1;if(typeof expected.content.decisionId!=='string')fallback+=1;}
  }
  assert.ok(found>=20&&fallback>=1,`seeded data must exercise both lookups (found ${found}, fallback ${fallback})`);
 }finally{await c.query('rollback');}
}));
