import { createHash } from "node:crypto";
import { safeEvidencePath } from "../../project-evidence/src/index.js";
import { withClient } from "./client.js";

export interface ContextSearchResult {
  id:string;kind:string;title:string;observedAt:string|null;freshness:"unverified"|"historical";confidence:"recorded"|"extracted";authority:"none";
  source:{table:string;key:string;path?:string;line?:number;hash?:string};target:{type:"file"|"run";value:string;line?:number};
}
/** Literal, project-scoped reads of existing stores. No index, approval or history writes. */
export async function searchProjectContext(project:string,query:string,kind="") {
  query=query.trim();
  if(query.length>200)throw new Error("Search is limited to 200 characters.");
  if(kind&&!['source','requirement','roadmap','decision','run','artifact','failure','agent','receipt'].includes(kind))throw new Error("Unknown evidence type.");
  const empty={schemaVersion:1,project,query,kind,authority:"none",limit:100,truncated:false,results:[] as ContextSearchResult[],scope:"Indexed paths and fact titles, run tasks, artifact kinds, agent identifiers, failures and receipt summaries. File bodies and artifact contents are not searched."};
  if(!query)return empty;
  return withClient(async c=>{
    // Filtering precedes the result window, including runs older than the graph window.
    const rows=await c.query<{kind:string;title:string;table_name:string;key:string;path:string|null;hash:string|null;line:number|null;run_id:string|null;observed_at:string|null;extracted:boolean}>(`
      with p as (select id from projects where root_uri=$1), candidates as (
        select 'source'::text kind,source_uri title,'project_files'::text table_name,source_uri key,source_uri path,content_hash hash,null::integer line,null::text run_id,updated_at::text observed_at,false extracted from project_files where project_id in(select id from p)
        union all
        select e->>'kind',left(e->>'title',500),'project_files',source_uri,source_uri,content_hash,
          case when e->>'line' ~ '^[1-9][0-9]{0,6}$' then (e->>'line')::integer end,null,updated_at::text,true
          from project_files cross join lateral jsonb_array_elements(case when jsonb_typeof(metadata->'evidenceEntries')='array' then metadata->'evidenceEntries' else '[]'::jsonb end) e
          where project_id in(select id from p) and e->>'kind' in ('requirement','roadmap','decision') and jsonb_typeof(e->'title')='string'
        union all
        select 'run',left(task,500),'workflow_runs',id::text,null,null,null,id::text,updated_at::text,false from workflow_runs where project_id in(select id from p)
        union all
        select 'artifact',left(a.kind,500),'artifacts',a.id::text,null,null,null,r.id::text,a.created_at::text,false from artifacts a join workflow_runs r on r.id=a.run_id where r.project_id in(select id from p)
        union all
        select 'agent',t.agent_id,'workflow_tasks',t.id::text,null,null,null,r.id::text,t.finished_at::text,false from workflow_tasks t join workflow_runs r on r.id=t.run_id where r.project_id in(select id from p) and t.agent_id is not null
        union all
        select 'failure','Failed task: '||coalesce(t.agent_id,'unassigned'),'workflow_tasks',t.id::text,null,null,null,r.id::text,t.finished_at::text,false from workflow_tasks t join workflow_runs r on r.id=t.run_id where r.project_id in(select id from p) and t.status='failed'
        union all
        select 'receipt',left(a.summary,500),'action_receipts',a.id::text,null,null,null,r.id::text,a.created_at::text,false from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id in(select id from p)
      ) select * from candidates where ($3='' or kind=$3) and position(lower($2) in lower(concat_ws(' ',title,key)))>0
      order by kind,title,key limit 501`,[project,query,kind]);
    const safe=rows.rows.filter(r=>!r.path||safeEvidencePath(r.path));
    const results=safe.slice(0,100).map(r=>({id:createHash('sha256').update(JSON.stringify([project,r.kind,r.extracted?`${r.key}:${r.line}`:r.key])).digest('hex'),kind:r.kind,title:r.title,observedAt:r.observed_at,freshness:r.path?'unverified' as const:'historical' as const,confidence:r.extracted?'extracted' as const:'recorded' as const,authority:'none' as const,source:{table:r.table_name,key:r.key,...(r.path?{path:r.path,hash:r.hash??undefined,...(r.line?{line:r.line}:{})}:{})},target:r.path?{type:'file' as const,value:r.path,...(r.line?{line:r.line}:{})}:{type:'run' as const,value:r.run_id!}}));
    return {...empty,results,truncated:safe.length>100||rows.rows.length>500};
  });
}
