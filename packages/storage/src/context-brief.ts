import {createHash} from 'node:crypto';
import type {EvidenceNode} from '../../project-evidence/src/index.js';
import {withClient} from './client.js';
import {projectEvidenceGraphInSnapshot} from './project-evidence.js';

export interface BriefFact { evidence:EvidenceNode; statement:string; correction?:{state:'recorded'|'stale';after:string;proposedBy:string;executedBy:string;approvalId:string;receiptId:string;receiptHash:string;observedAt:string}; }
export interface ProjectBrief {schemaVersion:1;project:string;authority:'none';status:'available'|'empty';generatedAt:string;snapshotHash:string;truncated:boolean;sections:{id:string;title:string;facts:BriefFact[];truncated:boolean}[];inferences:{statement:string;evidenceId:string}[];unknowns:string[];}
/** Deterministic explanation over one read-only snapshot; never an execution plan. */
export async function readProjectBrief(project:string):Promise<ProjectBrief>{
 return withClient(async c=>{await c.query('begin isolation level repeatable read read only');try{
  const graph=await projectEvidenceGraphInSnapshot(c,project);
  const definitions=[['goals','Recorded requirements','requirement',6],['roadmap','Recorded roadmap','roadmap',6],['decisions','Recorded decisions','decision',6],['activity','Recent recorded work','run',5],['failures','Recorded failures','failure',5]] as const;
  const sections=definitions.map(([id,title,kind,limit])=>{const nodes=graph.nodes.filter(n=>n.kind===kind);return {id,title,facts:nodes.slice(0,limit).map(evidence=>({evidence,statement:evidence.title}) as BriefFact),truncated:nodes.length>limit};});
  const ids=sections.flatMap(s=>s.facts.filter(f=>f.evidence.source.hash).map(f=>f.evidence.id));
  const corrections=await c.query(`select distinct on (a.target) a.target,a.id::text,a.receipt_hash,a.created_at::text as observed_at,a.metadata from action_receipts a join workflow_runs r on r.id=a.run_id join projects p on p.id=r.project_id where p.root_uri=$1 and a.action_type='context_correction_recorded' and a.target=any($2::text[]) order by a.target,case when a.metadata->>'revision' ~ '^[0-9]{1,15}$' then (a.metadata->>'revision')::bigint else 0 end desc,a.created_at desc,a.id desc`,[project,ids]);
  let stale=false;
  for(const section of sections)for(const fact of section.facts){const row=corrections.rows.find(r=>r.target===fact.evidence.id),m=row?.metadata;
   if(!m||typeof m.after!=='string'||m.after.length>500||typeof m.source?.hash!=='string'||typeof m.source?.path!=='string'||!['proposedBy','executedBy','approvalId'].every(k=>typeof m[k]==='string'))continue;
   const current=m.source.hash===fact.evidence.source.hash&&m.source.path===fact.evidence.source.path&&m.source.title===fact.evidence.title;
   fact.correction={state:current?'recorded':'stale',after:m.after,proposedBy:m.proposedBy,executedBy:m.executedBy,approvalId:m.approvalId,receiptId:row.id,receiptHash:row.receipt_hash,observedAt:row.observed_at};
   if(current)fact.statement=m.after;else stale=true;
  }
  const failures=sections.find(s=>s.id==='failures')!.facts;
  const inferences=failures.length?[{statement:'A retained failed task suggests reviewing its run evidence before choosing further work. It does not establish a current blocker or authorize a retry.',evidenceId:failures[0].evidence.id}]:[];
  const unknowns=['Indexed sources have not been compared with current disk contents.','Run completion and historical failures do not establish current health, feature acceptance or a current blocker.','The brief does not determine owners, deadlines, priorities or unrecorded dependencies.','Correction receipt references are retained; their complete chains and approval decisions are not independently reverified by this read.'];
  if(stale)unknowns.push('A correction refers to an older indexed source. Its annotation is shown separately and does not replace the indexed fact.');
  if(!sections.some(s=>s.id==='goals'&&s.facts.length))unknowns.push('No structured requirements were found in the retained graph window; project goals remain unknown.');
  const truncated=graph.truncated||sections.some(s=>s.truncated);if(truncated)unknowns.push('This brief is bounded. More indexed evidence or older activity may exist; use unified search and source/run evidence for further review.');
  const content={sections,inferences,unknowns,truncated};const snapshotHash=createHash('sha256').update(JSON.stringify(content)).digest('hex');
  await c.query('commit');return {schemaVersion:1,project,authority:'none',status:graph.nodes.length?'available':'empty',generatedAt:graph.generatedAt,snapshotHash,...content};
 }catch(e){await c.query('rollback');throw e;}});
}
