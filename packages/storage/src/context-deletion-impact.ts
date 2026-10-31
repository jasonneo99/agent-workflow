import { z } from 'zod';
import {canonicalJsonHash} from '../../policy-engine/src/index.js';
import {readProjectEvidenceGraph} from './project-evidence.js';
import {withClient} from './client.js';

/** Read-only impact projection over existing evidence and attribution stores.
 * Absence of recorded references never establishes deletion safety.
 */
export async function readContextDeletionImpact(project:string,nodeId:string){
 z.string().regex(/^[a-f0-9]{64}$/u).parse(nodeId);
 const graph=await readProjectEvidenceGraph(project),node=graph.nodes.find(n=>n.id===nodeId);
 if(!node)throw new Error('Evidence is unavailable in this project or outside the bounded graph window.');
 return withClient(async c=>{
  await c.query('begin isolation level repeatable read read only');try{
   const p=(await c.query('select id::text from projects where root_uri=$1',[project])).rows[0];if(!p)throw new Error('Project evidence unavailable.');
   const keys=[node.source.key,node.id,...(node.source.path?[node.source.path]:[])];
   if(node.kind==='artifact'){const a=(await c.query('select a.uri from artifacts a join workflow_runs w on w.id=a.run_id where w.project_id=$1 and a.id=$2::uuid',[p.id,node.source.key])).rows[0];if(a)keys.push(a.uri);}
   let sourceChanged=false;
   if(node.source.path){const f=(await c.query('select content_hash from project_files where project_id=$1 and source_uri=$2',[p.id,node.source.path])).rows[0];sourceChanged=f?.content_hash!==node.source.hash;}
   const edges=graph.relationships.filter(e=>e.from===node.id||e.to===node.id);
   const relatedIds=new Set(edges.flatMap(e=>[e.from,e.to]));relatedIds.delete(node.id);
   const relatedNodes=graph.nodes.filter(n=>relatedIds.has(n.id));
   const influence=(await c.query(`select r.id::text,coalesce(r.receipt_hash,'unchained') as "receiptHash",w.id::text as "runId",w.workflow_id as "workflowId",left(w.task,500) as task,coalesce(r.metadata->>'phase','unrecorded') as phase
    from action_receipts r join workflow_runs w on w.id=r.run_id
    where w.project_id=$1 and r.action_type in ('context_influence','context_influence_result')
      and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(r.metadata->'references')='array' then r.metadata->'references' else '[]'::jsonb end) ref
        where ref->>'key'=any($2::text[]) or ($3::text is not null and ref->>'sourceHash'=$3))
    order by r.created_at desc,r.id desc limit 201`,[p.id,keys,node.source.hash??null])).rows;
   const corrections=(await c.query(`select r.id::text,coalesce(r.receipt_hash,'unchained') as "receiptHash",r.target as "nodeId",w.id::text as "runId",coalesce(left(r.metadata->>'after',500),'Unrecorded correction') as value,coalesce(r.metadata->>'approvalId','unrecorded') as "approvalId"
    from action_receipts r join workflow_runs w on w.id=r.run_id where w.project_id=$1 and r.action_type='context_correction_recorded'
      and (r.target=$2 or r.metadata->'source'->>'path'=any($3::text[]) or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(r.metadata->'evidence')='array' then r.metadata->'evidence' else '[]'::jsonb end) ref where ref->>'path'=any($3::text[])))
    order by r.created_at desc,r.id desc limit 101`,[p.id,node.id,keys])).rows;
   const runIds=[...new Set([...influence.slice(0,200).map(r=>r.runId),...relatedNodes.filter(n=>n.target.type==='run').map(n=>n.target.value),...(node.target.type==='run'?[node.target.value]:[])])];
   const artifacts=(await c.query(`select a.id::text,a.run_id::text as "runId",a.kind,a.uri from artifacts a join workflow_runs w on w.id=a.run_id where w.project_id=$1 and a.run_id=any($2::uuid[]) order by a.created_at desc,a.id desc limit 101`,[p.id,runIds])).rows;
   await c.query('commit');
   const bounds={graph:graph.truncated,influence:influence.length>200,corrections:corrections.length>100,artifacts:artifacts.length>100};
   const snapshot={node,relationships:edges,relatedNodes,influence:influence.slice(0,200),corrections:corrections.slice(0,100),artifacts:artifacts.slice(0,100),bounds,sourceChanged};
   return {schemaVersion:1,project,nodeId,authority:'none',previewOnly:true,deletionAllowed:false,requiresApproval:true,safety:'not_established',snapshotHash:canonicalJsonHash(snapshot),...snapshot,
    unknowns:[...(Object.values(bounds).some(Boolean)?['This preview is bounded; additional recorded dependencies may exist.']:[]),...(sourceChanged?['The index changed while preparing this preview. Refresh before review.']:[]),
     'Indexed evidence has not been compared with current disk contents.',
     'Source facts are matched at file granularity; recorded context supply does not prove causal dependency.',
     'Semantic dependencies, older unrecorded context and recommendations without recorded references remain unknown.'],
    nextAction:'No deletion was performed. Resolve unknowns and use existing project policy, approval and receipt controls for any subsequent supported mutation. Audit history remains retained.'};
  }catch(e){await c.query('rollback');throw e;}
 });
}
