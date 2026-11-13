import { createHash } from 'node:crypto';
import { withClient } from '../../../../packages/storage/src/client.js';
import { sanitizeAssistantText } from '../../../../packages/conversation-contract/src/index.js';
import { acceptanceDigest } from '../../../../packages/storage/src/acceptance.js';
import { summarizeQueuePartnerGuideCircuitDiagnostics, type QueuePartnerGuideCircuitDiagnosticRow } from '../../../../packages/storage/src/queue-partner-guide-circuit.js';
import {summarizeQueuePartnerGuideRegistryHolds,type QueuePartnerGuideHoldRow,type QueuePartnerGuideRegistryHold} from '../../../../packages/storage/src/queue-partner-guide-holds.js';

export interface QueuePartnerActivityEntry {
 id:string;familyId:string;runId:string;title:string;state:string;kind:'decision'|'observation';
 what:string;why:string;how:string;next:string;evidence:Array<{label:string;url:string}>;requiresPermission:boolean;
}
export interface QueuePartnerActivityReport {
 version:1;authority:'evidence-only';scope:{projectId:string;rootUri:string;runId?:string};capacity:{repair:5;verifier:1};
 observedAt:string;entries:QueuePartnerActivityEntry[];watching?:string[];truncated:boolean;
}
export interface QueuePartnerActivityRun {id:string;projectId:string;rootUri:string;familyId:string;title:string;status:string;archived?:boolean;metadata?:Record<string,unknown>}
export interface QueuePartnerActivitySnapshot {
 runs:QueuePartnerActivityRun[];
 assignments:Array<{id:string;projectId:string;sourceRunId:string;childRunId?:string|null;familyId:string;role:string;state:string;owner?:string;fence?:string;reason?:string}>;
 receipts:Array<{id:string;runId:string;action:string;summary:string;metadata?:Record<string,unknown>;metadataSerializationVersion?:number;target?:string}>;
 artifacts:Array<{id:string;runId:string;kind:string;content:Record<string,unknown>}>;
 tasks:Array<{id:string;runId:string;status:string;stage:string;workerId?:string|null;leaseExpiresAt?:string|null}>;
 approvals:Array<{id:string;runId:string;status:string;action:string}>;
 helpRequests?:Array<{id:string;runId:string;status:string;acknowledgedAt?:string|null}>;
 guideCircuits?:QueuePartnerGuideCircuitDiagnosticRow[];
 guideRegistryHolds?:QueuePartnerGuideRegistryHold[];
 verifiedChainRunIds?:string[];truncated?:boolean;
}
export interface QueuePartnerActivityAdapter {snapshot(projectId:string,rootUri:string,runId?:string):Promise<QueuePartnerActivitySnapshot>}
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const defaults:QueuePartnerActivityAdapter={snapshot:(projectId,rootUri,runId)=>withClient(async c=>{
 const runs=(await c.query<QueuePartnerActivityRun>(`with recursive family(id) as (
  select r.id from workflow_runs r where r.project_id=$1::uuid and ($3::uuid is null or r.id=$3::uuid)
  union select linked.id from family f join workflow_runs current on current.id=f.id join workflow_runs linked on linked.project_id=$1::uuid and (
   linked.run_set_id=current.run_set_id or current.id::text in (linked.evaluation_metadata->>'sourceRunId',linked.evaluation_metadata->>'replayOfRunId',linked.evaluation_metadata->>'repairOriginRunId',linked.evaluation_metadata->>'parentRunId')
   or linked.id::text in (current.evaluation_metadata->>'sourceRunId',current.evaluation_metadata->>'replayOfRunId',current.evaluation_metadata->>'repairOriginRunId',current.evaluation_metadata->>'parentRunId'))
 ) select r.id::text,r.project_id::text as "projectId",p.root_uri as "rootUri",r.project_id::text||':'||r.run_set_id::text as "familyId",
 left(coalesce(r.construction_rationale->'presentation'->>'title',r.task),300) title,r.status,
 exists(select 1 from action_receipts dismissed where dismissed.run_id=r.id and dismissed.action_type in ('failed_run_dismissed','failed_run_superseded')
  and not exists(select 1 from action_receipts reinstated where reinstated.run_id=r.id and reinstated.action_type='failed_run_reinstated' and reinstated.created_at>dismissed.created_at)) archived,
 jsonb_build_object('sourceRunId',r.evaluation_metadata->>'sourceRunId','replayOfRunId',r.evaluation_metadata->>'replayOfRunId','repairOriginRunId',r.evaluation_metadata->>'repairOriginRunId','parentRunId',r.evaluation_metadata->>'parentRunId') metadata
 from workflow_runs r join projects p on p.id=r.project_id where r.project_id=$1::uuid and p.root_uri=$2 and r.id in(select id from family)
 order by case when r.status in ('leased','running','queued') then 0 else 1 end,r.started_at desc,r.id limit 101`,[projectId,rootUri,runId??null])).rows;
 const ids=runs.slice(0,100).map(r=>r.id),available=Boolean((await c.query("select to_regclass('queue_coordinator_assignments') name")).rows[0]?.name);
 const assignments=available?(await c.query(`select id::text,project_id::text as "projectId",source_run_id::text as "sourceRunId",child_run_id::text as "childRunId",family_id as "familyId",role,state,owner,fence::text,reason from queue_coordinator_assignments where project_id=$1::uuid and (source_run_id=any($2::uuid[]) or child_run_id=any($2::uuid[])) order by updated_at desc limit 101`,[projectId,ids])).rows:[];
 const receipts=(await c.query(`select a.id::text,a.run_id::text as "runId",a.action_type action,left(a.summary,1200) summary,a.metadata,a.metadata_serialization_version as "metadataSerializationVersion",a.target from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.run_id=any($2::uuid[]) and a.action_type=any($3::text[]) order by a.created_at desc limit 201`,[projectId,ids,['queue_coordinator_reserved','queue_coordinator_dispatched','queue_coordinator_finished','operator_no_effect_reservation_reconciled','operator_verifier_assignment_reconciled','stage_failed','stage_blocked','queue_partner_technical_help_requested','queue_partner_decision','operator_evidence_review']])).rows;
 const artifacts=(await c.query(`select a.id::text,a.run_id::text as "runId",a.kind,case when a.kind='command_output' then jsonb_build_object('exitCode',a.content->'exitCode','timedOut',a.content->'timedOut') else a.content end as content from artifacts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.run_id=any($2::uuid[]) and a.kind=any($3::text[]) order by a.created_at desc limit 101`,[projectId,ids,['repaired_revision_candidate','repaired_revision_attestation','operator_verifier_context_correction','operator_evidence_review','queue_partner_decision','command_output']])).rows;
 const tasks=(await c.query(`select t.id::text,t.run_id::text as "runId",t.status,t.stage_id stage,t.worker_id as "workerId",t.lease_expires_at::text as "leaseExpiresAt" from workflow_tasks t join workflow_runs r on r.id=t.run_id where r.project_id=$1::uuid and t.run_id=any($2::uuid[]) and t.status=any($3::text[]) order by t.started_at desc limit 101`,[projectId,ids,['queued','leased','running']])).rows;
 const approvals=(await c.query(`select a.id::text,a.run_id::text as "runId",a.status,a.action_type action from action_approvals a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.run_id=any($2::uuid[]) and a.status=any($3::text[]) order by a.created_at desc limit 101`,[projectId,ids,['pending','executing','failed']])).rows;
 const helpRequests=(await c.query(`select n.id::text,n.run_id::text as "runId",n.status,n.acknowledged_at::text as "acknowledgedAt" from run_notifications n join workflow_runs r on r.id=n.run_id where r.project_id=$1::uuid and n.run_id=any($2::uuid[]) and n.channel='codex' and n.event_key like 'queue-partner-help:%' order by n.created_at desc limit 101`,[projectId,ids])).rows;
 const guideCircuitRows=(await c.query(`select a.metadata,a.run_id::text as "runId",
  (select t.worker_id from workflow_tasks t where t.run_id=a.run_id and t.worker_id is not null order by coalesce(t.finished_at,t.started_at,t.available_at) desc,t.id desc limit 1) "workerId",
  a.receipt_hash is not null and a.receipt_hash ~ '^[a-f0-9]{64}$' and (a.prev_hash='GENESIS' or exists(select 1 from action_receipts p where p.run_id=a.run_id and p.receipt_hash=a.prev_hash)) "receiptAuthentic"
  from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.action_type='guide_circuit_transition'
  order by a.created_at desc,a.id desc limit 501`,[projectId])).rows.reverse();
 const guideHoldRows=(await c.query(`select a.run_id::text "runId",a.action_type action,a.created_at::text "createdAt",a.metadata from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.action_type in ('guide_registry_not_ready','guide_registry_ready') order by a.created_at,a.id limit 1001`,[projectId])).rows as QueuePartnerGuideHoldRow[];
 const guideRegistryHolds=summarizeQueuePartnerGuideRegistryHolds(guideHoldRows.slice(0,1000),projectId);
 const proofCandidates=[...new Set(artifacts.filter(a=>['queue_partner_decision','operator_evidence_review'].includes(a.kind)).map(a=>a.runId))];
 const verifiedChainRunIds:string[]=[];const {verifyRunReceiptChainOnClient}=await import('../../../../packages/storage/src/postgres.js');
 for(const id of proofCandidates.slice(0,12))if((await verifyRunReceiptChainOnClient(c,id)).valid)verifiedChainRunIds.push(id);
 return {runs:runs.slice(0,100),assignments:assignments.slice(0,100),receipts:receipts.slice(0,200),artifacts:artifacts.slice(0,100),tasks:tasks.slice(0,100),approvals:approvals.slice(0,100),helpRequests:helpRequests.slice(0,100),guideCircuits:guideCircuitRows.slice(-500),guideRegistryHolds,verifiedChainRunIds,truncated:runs.length>100||assignments.length>100||receipts.length>200||artifacts.length>100||tasks.length>100||approvals.length>100||helpRequests.length>100||guideCircuitRows.length>500||guideHoldRows.length>1000||proofCandidates.length>12};
})};
function scrub(value:unknown,max=400):string{return sanitizeAssistantText(typeof value==='string'?value:'',2000)
 .replace(/```[\s\S]*?```|`[^`]*`/gu,'[REDACTED_COMMAND]').replace(/https?:\/\/[^\s]+/giu,'[REDACTED_URL]')
 .replace(/\b(?:npm|npx|node|python\d*|ssh|sudo|curl|bash|zsh|git|docker|systemctl|launchctl|rm|cp|mv|cat|echo|printf)\b[^\n]*/giu,'[REDACTED_COMMAND]')
 .replace(/\/(?:[^\s/,;]+\/)+[^\s,;]*/gu,'[REDACTED_PATH]').replace(/\b[A-Za-z0-9_+/=-]{40,}\b/gu,'[REDACTED_VALUE]').slice(0,max);}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
/** Read-only evidence projection. Decisions are labelled only when durable receipts establish them. */
export async function buildQueuePartnerActivity(projectId:string,rootUri:string,runId?:string,adapter:QueuePartnerActivityAdapter=defaults):Promise<QueuePartnerActivityReport>{
 if(!UUID.test(projectId)||!rootUri.startsWith('/')||(runId!==undefined&&!UUID.test(runId)))throw new Error('Exact registered project and optional run identity required');
 const data=await adapter.snapshot(projectId,rootUri,runId);
 let runs=(Array.isArray(data.runs)?data.runs:[]).filter(r=>r&&UUID.test(r.id)&&r.projectId===projectId&&r.rootUri===rootUri).slice(0,100).map(r=>({...r}));
 if(runId){const allowed=new Set([runId]);let changed=true;while(changed){changed=false;for(const r of runs){const links=['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].map(k=>r.metadata?.[k]);if(allowed.has(r.id)||runs.some(other=>allowed.has(other.id)&&(other.familyId===r.familyId||links.includes(other.id)||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(k=>other.metadata?.[k]===r.id)))){if(!allowed.has(r.id)){allowed.add(r.id);changed=true;}}}}runs=runs.filter(r=>allowed.has(r.id));}
 const byId=new Map(runs.map(r=>[r.id,r]));
 // The adapter enforces canonical membership; independently refuse foreign scope.
 if(runId&&!byId.has(runId))return {version:1,authority:'evidence-only',scope:{projectId,rootUri,runId},capacity:{repair:5,verifier:1},observedAt:new Date().toISOString(),entries:[],truncated:Boolean(data.truncated)};
 const entries:Array<QueuePartnerActivityEntry&{priority:number}>=[];
 const add=(run:QueuePartnerActivityRun,category:string,priority:number,body:Omit<QueuePartnerActivityEntry,'id'|'familyId'|'runId'|'title'|'evidence'>)=>{
  const clean={...body,what:scrub(body.what),why:scrub(body.why),how:scrub(body.how),next:scrub(body.next)};
  entries.push({id:`${category}:${hash({runId:run.id,...clean})}`,familyId:run.familyId,runId:run.id,title:scrub(run.title,180),...clean,evidence:[{label:'Inspect preserved run evidence',url:`/runs?relatedTo=${encodeURIComponent(run.id)}`}],priority});
 };
 for(const hold of Array.isArray(data.guideRegistryHolds)?data.guideRegistryHolds:[]){
  if(hold.projectId!==projectId||!hold.affectedRunIds.length)continue;const run=hold.affectedRunIds.map(id=>byId.get(id)).find(Boolean);if(!run)continue;
  add(run,'guide-registry-hold',hold.state==='open'?84:25,{state:`guide-registry-${hold.state}`,kind:'observation',what:`Guide registry adoption hold is ${hold.state} for ${hold.affectedRunIds.length} affected run(s).`,why:'Per-run Guide skips remain preserved while this project-generation view removes duplicate operator noise.',how:'Evidence-only coalescing; no skipped run was replayed and no primary workflow outcome was accepted.',next:hold.state==='open'?'Deploy the expected Guide actor registry generation; primary workflows continue without Guide.':'Use the resolution receipt as runtime-adoption evidence only.',requiresPermission:false});
 }
 for(const circuit of summarizeQueuePartnerGuideCircuitDiagnostics(Array.isArray(data.guideCircuits)?data.guideCircuits:[],projectId)){
  if(circuit.status==='healthy'||!circuit.sourceRunId)continue;
  const run=byId.get(circuit.sourceRunId);if(!run)continue;
  const timing=circuit.status==='cooldown'&&circuit.retryAt?` Retry after ${circuit.retryAt}.`:circuit.status==='recovery-probe'&&circuit.probeExpiresAt?` Probe lease expires ${circuit.probeExpiresAt}.`:'';
  add(run,'guide-circuit',circuit.status==='quarantined'?99:circuit.status==='recovery-overdue'?88:72,{state:`guide-${circuit.status}`,kind:'observation',what:`Guide circuit ${circuit.taskClass} is ${circuit.status} at generation ${circuit.generation}.${timing}`,why:circuit.reason??(circuit.status==='quarantined'?`${circuit.quarantined} circuit event(s) failed bounded validation.`:'The durable task-class breaker is preserving the primary workflow.'),how:`Receipt-backed diagnostic only; it grants no reset or execution authority.${circuit.affectedWorkers.length?` Observed workers: ${circuit.affectedWorkers.join(', ')}.`:''}`,next:circuit.reconciliation,requiresPermission:false});
 }
 const assignments=(Array.isArray(data.assignments)?data.assignments:[]).filter(a=>a&&a.projectId===projectId&&byId.has(a.sourceRunId)).slice(0,100);
 // Display-family linking is evidence navigation only, never execution scope.
 for(const a of assignments){const source=byId.get(a.sourceRunId),child=a.childRunId?byId.get(a.childRunId):undefined;if(source&&a.familyId===source.familyId&&child)child.familyId=source.familyId;}
 for(let pass=0;pass<runs.length;pass++){let changed=false;for(const run of runs){const parent=['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].map(k=>run.metadata?.[k]).find(id=>typeof id==='string'&&byId.has(id));if(typeof parent==='string'&&byId.get(parent)!.familyId!==run.familyId){run.familyId=byId.get(parent)!.familyId;changed=true;}}if(!changed)break;}
 const latestAssignment=new Map<string,(typeof assignments)[number]>();for(const a of assignments)if(!latestAssignment.has(a.familyId))latestAssignment.set(a.familyId,a);
 const runOrder=new Map(runs.map((run,index)=>[run.id,index]));
 for(const run of runs){
  const latest=latestAssignment.get(run.familyId),isCurrentChild=latest?.childRunId===run.id,hasNewerChild=Boolean(latest?.childRunId&&byId.has(latest.childRunId)&&latest.childRunId!==run.id);
  const approvals=(Array.isArray(data.approvals)?data.approvals:[]).filter(a=>a&&a.runId===run.id&&['pending','executing','failed'].includes(a.status));
  const pendingApprovals=approvals.filter(a=>a.status==='pending'),executingApprovals=approvals.filter(a=>a.status==='executing'),failedApprovals=approvals.filter(a=>a.status==='failed');
  if(pendingApprovals.length)add(run,'permission',100,{state:'permission-needed',kind:'observation',what:`${pendingApprovals.length} governed item(s) await a specific permission decision.`,why:'Current pending approval records require a human decision; no blanket approval is inferred.',how:'The coordinator preserves exact approvals rather than approving or dismissing them.',next:'Review the exact permission and payload; unrelated eligible families may continue.',requiresPermission:true});
  if(executingApprovals.length)add(run,'authorized-execution',95,{state:'authorized-action-executing',kind:'observation',what:`${executingApprovals.length} already-authorized action(s) are executing.`,why:'Executing approval status is not a missing human permission.',how:'The existing governed action owns execution; this view neither approves nor retries it.',next:'Wait for the exact execution result and reconcile its receipt before any dependent work.',requiresPermission:false});
  if(failedApprovals.length)add(run,'failed-execution',91,{state:'authorized-action-failed',kind:'observation',what:`${failedApprovals.length} governed action execution(s) failed.`,why:'A failed execution needs technical reconciliation, not an automatic repeat approval question.',how:'Failure does not authorize a retry or undo existing approval history.',next:'Inspect the exact failed action and current preimage; ask for a new permission only if a new pending request requires it.',requiresPermission:false});
  const task=(Array.isArray(data.tasks)?data.tasks:[]).find(t=>t&&t.runId===run.id&&['leased','running'].includes(t.status));
  const assignment=assignments.find(a=>a.childRunId===run.id);
  if(task){const expired=Boolean(task.leaseExpiresAt&&Number.isFinite(Date.parse(task.leaseExpiresAt))&&Date.parse(task.leaseExpiresAt)<Date.now()),fenced=Boolean(assignment&&assignment.state==='running'&&task.workerId===`${assignment.owner}:${assignment.fence}`);
   add(run,'worker',expired||!fenced?98:96,{state:expired?'lease-expired':fenced?'working':'worker-binding-unverified',kind:'observation',what:expired?'The recorded worker lease has expired.':fenced?`A coordinator-bound worker is executing ${scrub(task.stage,50)}.`:'An active task does not match a current coordinator worker binding.',why:expired?'Lease expiry does not prove the old writer stopped.':fenced?'Current task worker identity matches the assignment owner and fence.':'A stale or unrelated worker must not be assumed to verify the frozen candidate.',how:'Task lease and durable assignment are compared; this is an observation, not proof of all runtime gates.',next:expired||!fenced?'Reconcile ownership and candidate identity before any retry; do not accept mismatched checkout claims.':'Wait for actual executed evidence and independent acceptance; do not duplicate this family.',requiresPermission:false});
  }
  if(run.archived&&!task&&!approvals.length)continue;
  const receipt=(Array.isArray(data.receipts)?data.receipts:[]).find(r=>r&&r.runId===run.id&&['stage_blocked','stage_failed'].includes(r.action));
  if(receipt){const reason=scrub(receipt.summary),checks=/test|check|compil|typecheck|assert/iu.test(reason),historical=hasNewerChild||!['blocked','failed'].includes(run.status);
   add(run,'blocker',historical?30:isCurrentChild?90:80,{state:historical?'historical-stage-report':checks?'verification-gap':'technical-blocker',kind:'observation',what:historical?'An earlier stage report is preserved; current lifecycle or assigned work has moved on.':checks?'The current assigned stage reports an unresolved verification/check issue.':'A stage reports a technical blocker.',why:`${historical?'HISTORICAL report, not a current diagnosis: ':''}${reason||'The receipt does not contain a usable bounded reason.'}`,how:'This is a preserved stage report; it is not independent verification that the diagnosed cause remains current or that new permission is required.',next:historical?'Follow the newest assigned attempt and its actual evidence; do not replay this historical blocker.':'Compare the report with current source and executed receipts; repair the demonstrated root cause, not an unchanged replay. Escalate only an exact demonstrated permission or unavailable proof boundary.',requiresPermission:false});
  }
  for(const a of assignments.filter(a=>a.sourceRunId===run.id).slice(0,3)){
   const decision=(Array.isArray(data.receipts)?data.receipts:[]).find(r=>r&&r.runId===run.id&&['queue_coordinator_reserved','queue_coordinator_dispatched','queue_coordinator_finished','operator_no_effect_reservation_reconciled','operator_verifier_assignment_reconciled'].includes(r.action)&&r.metadata?.id===a.id);
   add(run,'assignment',a.state==='uncertain'?98:a.state==='held'||a.state==='failed'?75:50,{state:a.state,kind:'observation',what:`The ${a.role==='verifier'?'independent verifier':'repair'} assignment is ${scrub(a.state,30)}.`,why:decision?`The assignment has a matching action receipt: ${scrub(decision.summary)}. Selection rationale requires its separate recorded decision.`:'The durable assignment records its current state; no selection rationale was recorded in this bounded evidence.',how:a.state==='uncertain'?'Reservation uncertainty retains ownership; automatic takeover is inhibited.':scrub(a.reason)||'Existing coordinator claims and intent fencing govern execution.',next:a.state==='uncertain'?'Prove whether effects occurred and reconcile the exact reservation once; do not create another repair.':a.state==='held'||a.state==='failed'?'Resolve the recorded technical or authority boundary using changed evidence before continuation.':'Follow the existing assignment; only independent verification can establish acceptance.',requiresPermission:false});
  }
  const artifacts=(Array.isArray(data.artifacts)?data.artifacts:[]).filter(a=>a&&a.runId===run.id&&a.content&&typeof a.content==='object');
  for(const review of artifacts.filter(a=>a.kind==='operator_evidence_review').slice(0,1)){const p=review.content;
   const linked=(Array.isArray(data.receipts)?data.receipts:[]).some(r=>r&&r.runId===run.id&&r.action==='operator_evidence_review'&&r.metadataSerializationVersion===2&&r.target===run.id&&acceptanceDigest(r.metadata)===acceptanceDigest(p));
   if(!linked||p.version!==1||p.authority!=='evidence-only'||p.actor!=='operator'||p.projectId!==projectId||p.runId!==run.id||p.familyId!==run.familyId)continue;
   if(!data.verifiedChainRunIds?.includes(run.id)){add(run,'unverified-review',60,{state:'unverified-review-record',kind:'observation',what:'A stored operator-review record lacks verified full-chain proof in this view.',why:'Matching artifact and receipt metadata alone do not establish an intact receipt chain.',how:'The review is not treated as a confirmed diagnosis, acceptance, permission or execution authority.',next:'Verify the complete receipt chain before relying on this review; preserve the original records.',requiresPermission:false});continue;}
   add(run,'operator-review',hasNewerChild?40:93,{state:'operator-reviewed',kind:'observation',what:`Operator evidence review: ${scrub(p.what)}`,why:scrub(p.why),how:`A matching operator review artifact and receipt are recorded; this is not acceptance or new execution authority. ${scrub(p.how)}`,next:scrub(p.next),requiresPermission:pendingApprovals.length>0});
  }
  const successes=artifacts.filter(a=>a.kind==='command_output'&&a.content.exitCode===0&&a.content.timedOut!==true).length;
  if(successes)add(run,'successful-checks',isCurrentChild?70:hasNewerChild?25:60,{state:'recorded-check-success',kind:'observation',what:`${successes} successful governed command output(s) are recorded for this attempt.`,why:'Executed zero-exit results exist, unlike unexecuted stage claims.',how:'Passing commands alone do not prove all original requirements, source freshness, packaging or acceptance.',next:'Use exact source-bound receipts in the independent gate review; keep unresolved gates visible.',requiresPermission:false});
  if(artifacts.some(a=>a.kind==='command_output'&&(a.content.timedOut===true||(typeof a.content.exitCode==='number'&&a.content.exitCode!==0))))add(run,'failed-check',hasNewerChild||run.status==='completed'||task?15:65,{state:'recorded-check-failure',kind:'observation',what:'Preserved command history includes a nonzero exit or timeout.',why:'A failure output exists; this bounded projection has not established whether newer checks superseded it.',how:'This is historical executed evidence, not a claim that the current candidate still fails.',next:'Inspect the latest source-bound check receipts before repairing or replaying any failure.',requiresPermission:false});
  const help=(Array.isArray(data.helpRequests)?data.helpRequests:[]).find(n=>n&&n.runId===run.id);
  if(help)add(run,'help',hasNewerChild?35:85,{state:hasNewerChild?'historical-help-request':'technical-help-requested',kind:'observation',what:hasNewerChild?'An earlier technical-help request remains in the preserved outbox history.':'Technical help has been requested from the original Codex conversation.',why:`The durable help outbox records ${scrub(help.status,30)}${help.acknowledgedAt?'; recipient acknowledgment is recorded':''}.`,how:'A queued or delivered notification is not evidence that Codex is currently working, a repair ran or a check passed. Existing policy and approval gates remain unchanged.',next:hasNewerChild?'Follow the newer assigned attempt rather than issuing duplicate help.':'Follow the original technical-help checkpoint; do not duplicate a repair or ask for blanket permission.',requiresPermission:false});
  const journals=artifacts.filter(a=>a.kind==='queue_partner_decision').slice(0,5);
  for(const journal of journals){const p=journal.content;
   const linked=(Array.isArray(data.receipts)?data.receipts:[]).some(r=>r&&r.runId===run.id&&r.action==='queue_partner_decision'&&r.metadataSerializationVersion===2&&r.target===run.familyId&&r.metadata?.decisionId===p.decisionId&&acceptanceDigest(r.metadata)===acceptanceDigest(p));
   if(!linked||p.version!==1||p.authority!=='evidence-only'||p.projectId!==projectId||p.runId!==run.id||p.familyId!==run.familyId||typeof p.decisionId!=='string'||!['repair-selected','verifier-selected','held','active','verified','outcome'].includes(String(p.decision)))continue;
   if(!data.verifiedChainRunIds?.includes(run.id)){add(run,'unverified-decision',60,{state:'unverified-decision-record',kind:'observation',what:'A stored decision record lacks verified full-chain proof in this view.',why:'Exact metadata linkage does not independently verify historical chain integrity.',how:'No confident coordinator decision or permission is inferred from this record.',next:'Verify the complete run receipt chain before relying on this decision explanation.',requiresPermission:false});continue;}
   add(run,'journal',60,{state:'recorded-decision',kind:'decision',what:scrub(p.what),why:scrub(p.why),how:`Recorded coordinator decision, not a substitute for current worker/approval evidence. ${scrub(p.how)}`,next:scrub(p.next),requiresPermission:pendingApprovals.length>0});
  }
  if(artifacts.some(a=>a.kind==='repaired_revision_attestation'))add(run,'attestation',70,{state:'attestation-recorded',kind:'observation',what:'A repaired-revision attestation is recorded.',why:'An attestation artifact exists; this projection has not independently revalidated its chain or current source.',how:'Source, runtime acceptance and user acceptance remain distinct; original history is retained.',next:'Revalidate exact current source, four gates and receipt chains before any closure or dismissal.',requiresPermission:false});
  else if(artifacts.some(a=>a.kind==='repaired_revision_candidate'))add(run,'candidate',65,{state:'awaiting-independent-verification',kind:'observation',what:'A source candidate has been recorded for independent verification.',why:'A candidate is not acceptance, even when its repair attempt completed.',how:'The separate verifier must evaluate every unchanged original requirement and gate.',next:'Use the existing verifier lane; do not start another repair solely because verification is pending.',requiresPermission:false});
  if(run.status==='completed'&&!task)add(run,'lifecycle',10,{state:'lifecycle-completed',kind:'observation',what:'This attempt reached lifecycle completion.',why:'Completed lifecycle status alone does not establish product acceptance or permission to dismiss.',how:'Original requirements, approvals and evidence history remain authoritative.',next:'Inspect the current acceptance and receipt proof before treating this family as resolved.',requiresPermission:false});
 }
 entries.sort((a,b)=>b.priority-a.priority||(runOrder.get(a.runId)??100)-(runOrder.get(b.runId)??100));
 const counts=new Map<string,number>();const visible=entries.filter(entry=>{const n=counts.get(entry.familyId)??0;if(n>=5&&entry.priority<96)return false;counts.set(entry.familyId,n+1);return true;});
 const selected=visible.slice(0,30).map(({priority,...entry})=>entry);
 const activeAssignments=assignments.filter(a=>['reserved','running','uncertain'].includes(a.state));
 const repairs=new Set(activeAssignments.filter(a=>a.role==='repair').map(a=>a.familyId)).size;
 const verifiers=new Set(activeAssignments.filter(a=>a.role==='verifier').map(a=>a.familyId)).size;
 const working=entries.filter(e=>e.state==='working');
 const pending=entries.filter(e=>e.state==='permission-needed');
 const held=new Set(assignments.filter(a=>['held','failed'].includes(a.state)).map(a=>a.familyId)).size;
 const watching=[
  `Reviewing the selected project queue: ${repairs}/5 repair slots and ${verifiers}/1 verifier slots have recorded reservations; ${working.length} worker-bound stage(s) observed. Reservations are not proof of running work.`,
  repairs<5?'Next: select an eligible unrelated family for an available slot, or recover its missing evidence. Empty slots do not authorize duplicate repairs.':'Repair reservations are full; the next scheduling opportunity is a released slot.',
  ...(pending.length?[`${pending.length} specific permission hold(s) are visible; unrelated eligible work can continue.`]:[]),
  ...(held?[`${held} assigned family hold(s) need evidence or acceptance reconciliation. Inspect each concrete Next action; no terminal attempt is reset.`]:[]),
  ...(data.truncated?['This project snapshot is bounded; slot counts are partial, not global coordinator utilization.']:['These are selected-project observations, not a global scheduler heartbeat or proof that all remaining families are eligible.'])
 ];
 return {version:1,authority:'evidence-only',scope:{projectId,rootUri,...(runId?{runId}:{})},capacity:{repair:5,verifier:1},observedAt:new Date().toISOString(),entries:selected,watching,truncated:Boolean(data.truncated)||entries.length>selected.length};
}
