import type {Client} from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acceptanceDigest} from './acceptance.js';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {sourceSubjectHash} from '../../workflow-engine/src/source-subject.js';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const exact=(a:unknown,b:unknown)=>acceptanceDigest(a)===acceptanceDigest(b);
const relative=(p:unknown):p is string=>typeof p==='string'&&p.length>0&&!path.isAbsolute(p)
 &&!/[\\*?\[\]{}]/u.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..');

/** Historical observations only. Never resolve a project-relative target against
 * the verifier's root when the receipt names another project. Repeated writes
 * are retained individually; no current postimage or replay authority is claimed. */
export function qualifiedVerifierEffects(receipts:any[],artifacts:any[],projects:{id:string;root_uri:string}[]) {
 if(receipts.length>1000||artifacts.length!==receipts.length||Buffer.byteLength(JSON.stringify({receipts,artifacts}))>16_000_000)throw Error('Bounded complete verifier effect review required');
 const used=new Set<string>();
 return receipts.map(r=>{
  const m=r.metadata;
  if(r.action_type!=='file_write'||!m||m.relativePath!==r.target||!relative(r.target)
   ||! /^[a-f0-9]{64}$/u.test(r.receipt_hash??'')||! /^[a-f0-9]{64}$/u.test(m.nextHash??'')
   ||typeof m.existed!=='boolean'||!Number.isSafeInteger(m.bytesWritten)||m.bytesWritten<0
   ||m.outcome!==undefined&&m.outcome!=='applied'||typeof m.absolutePath!=='string')throw Error('Only finalized qualified source writes may be observed');
  const matches=projects.filter(p=>path.join(p.root_uri,r.target)===m.absolutePath
   &&(!m.projectId||m.projectId===p.id)&&(!m.projectRoot||m.projectRoot===p.root_uri));
  const pairs=artifacts.filter(a=>a.kind==='file_write'&&exact(a.content,m));
  if(matches.length!==1||pairs.length!==1||used.has(pairs[0].uri))throw Error('Ambiguous project or historical effect pairing');
  used.add(pairs[0].uri);
  return {projectId:matches[0].id,root:matches[0].root_uri,path:r.target,receiptHash:r.receipt_hash,artifactUri:pairs[0].uri,metadataDigest:acceptanceDigest(m)};
 });
}

export interface VerifierReassessmentInput {
 runId:string;assignmentId:string;expectedFence:string;owner:string;intentFence:string;
 actor:string;authorizationReference:string;sourcePaths:string[];commands:string[];
 verifierReassessment?:{authorizationUri:string};
}

/** An operator-only, separately authorized verifier assessment. It is not a
 * repaired-source phase, recipe retry, candidate promotion or generic recovery. */
export async function inspectVerifierReassessment(c:Client,input:VerifierReassessmentInput,q:any,run:any) {
 if(!input.verifierReassessment)return undefined;
 if(q.state!=='held'||q.role!=='verifier'||q.prior_child!==input.runId||run.status!=='failed'
  ||!run.evaluation_metadata?.existingAssignmentReconciliationUri)throw Error('Exact failed held verifier required');
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='existing_assignment_verifier_reassessed' limit 1",[input.runId])).rowCount)throw Error('One-time verifier reassessment already consumed');
 if((await c.query("select 1 from action_receipts where run_id=$1 and target=$2 and action_type='operator_verifier_reassessment_revoked' limit 1",[input.runId,input.verifierReassessment.authorizationUri])).rowCount)throw Error('Verifier reassessment authority revoked');
 if((await c.query("select 1 from action_approvals where run_id=$1 and status in ('pending','executing') limit 1",[input.runId])).rowCount)throw Error('Pending verifier action requires its own decision');
 const rows=(await c.query(`select a.content,a.created_at from artifacts a join action_receipts r
  on r.run_id=a.run_id and r.target=a.uri and r.metadata=a.content and r.receipt_hash is not null
  and r.agent_id='workflow-orchestrator' and r.action_type='operator_verifier_reassessment_authorized'
  where a.run_id=$1 and a.uri=$2 and a.kind='verifier_reassessment_authorization'`,[input.runId,input.verifierReassessment.authorizationUri])).rows;
 const grant=rows.length===1?rows[0].content:null;
 if(!grant||grant.version!==1||grant.authority!=='direct-human'||grant.approvalDecision!=='approved'
  ||grant.operation!=='one-time-current-revision-verifier-reassessment'||grant.maxAssessments!==1
  ||grant.runId!==input.runId||grant.assignmentId!==input.assignmentId||grant.assignmentFence!==input.expectedFence
  ||grant.projectId!==q.project_key||grant.sourceRunId!==q.source_id||grant.owner!==input.owner||grant.intentFence!==input.intentFence
  ||grant.actor!==input.actor||grant.authorizationReference!==input.authorizationReference
  ||grant.stateVersion!==String(run.state_version)||grant.taskHash!==acceptanceDigest(run.task)
  ||grant.frozenPolicyDigest!==acceptanceDigest(run.policy_snapshot)||!exact(grant.sourcePaths,input.sourcePaths)
  ||!exact(grant.commands,input.commands)||!/^human-message:[^\s]+$/u.test(grant.instructionReference??'')
  ||typeof grant.instructionText!=='string'||!grant.instructionText.length||grant.instructionText.length>8192
  ||hash(grant.instructionText)!==grant.instructionSha256||!Number.isFinite(Date.parse(grant.expiresAt))
  ||Date.parse(grant.expiresAt)<=Date.now()||Date.parse(grant.expiresAt)>new Date(rows[0].created_at).getTime()+3600000
  ||!exact(grant.requiredGates,['implementation','verification','packaging','supervision']))throw Error('Fresh exact verifier reassessment authority required');
 const candidate=(await c.query("select payload,digest from repaired_revision_records where id=$1 and kind='candidate'",[grant.candidateId])).rows[0];
 if(!candidate||candidate.digest!==grant.candidateDigest||acceptanceDigest(candidate.payload)!==candidate.digest
  ||run.evaluation_metadata.repairedRevisionCandidateId!==grant.candidateId
  ||candidate.payload.sourceRunId!==q.source_id||candidate.payload.projectId!==q.project_key)throw Error('Immutable verifier candidate binding changed');
 if(await sourceSubjectHash(q.root_uri,input.sourcePaths)!==grant.sourceHash)throw Error('Verifier source changed after authorization');
 const current=resolveExecutionPolicy(await loadProjectConfig(q.root_uri),run.policy_profile).project;
 if(acceptanceDigest(current)!==grant.currentPolicyDigest||run.policy_snapshot.actions.isolate_command_writes!==true
  ||run.policy_snapshot.actions.allowed_write_paths?.length)throw Error('Verifier policy binding or isolation changed');
 for(const command of input.commands){assertCommandAllowed(command,current);if(!run.policy_snapshot.actions.allowed_commands.includes(command))throw Error('Verifier reassessment cannot add commands');}
 if(!Array.isArray(grant.ptyCommands)||grant.ptyCommands.some((s:unknown)=>s!=='python3 -m unittest discover -s tests'
  ||!input.commands.includes(s)||!current.actions.scoped_native_pty_commands?.includes(s)))throw Error('Exact prospective synthetic-test PTY recipe required');
 const tasks=(await c.query('select * from workflow_tasks where run_id=$1 order by id for update',[input.runId])).rows;
 if(!exact(grant.taskSnapshotDigest,acceptanceDigest(tasks))||tasks.length!==4
  ||!exact(tasks.map(t=>t.stage_id).sort(),[...grant.requiredGates].sort())
  ||tasks.filter(t=>t.status==='failed').length!==1
  ||tasks.some(t=>!['failed','cancelled'].includes(t.status)||t.status==='cancelled'&&(t.attempts!==0||t.started_at||t.worker_id)
   ||t.lease_expires_at&&new Date(t.lease_expires_at).getTime()>Date.now()))throw Error('Exact failed and never-started cancelled verifier gates required');
 const failed=tasks.find(t=>t.status==='failed');
 const failure=(await c.query("select * from action_receipts where run_id=$1 and action_type='stage_failed' order by created_at desc limit 1",[input.runId])).rows[0];
 if(!failure?.receipt_hash||failure.target!==failed.id||new Date(rows[0].created_at)<=new Date(failure.created_at))throw Error('Latest verifier failure must precede fresh authority');
 for(const task of tasks.filter(t=>t.status==='cancelled')){
  const proof=(await c.query("select * from action_receipts where run_id=$1 and target=$2 and action_type='stage_cancelled' order by created_at desc limit 1",[input.runId,task.id])).rows[0];
  if(!proof?.receipt_hash||proof.metadata?.causeTaskId!==failed.id||proof.metadata.nextStatus!=='cancelled'
   ||new Date(proof.created_at)<new Date(failure.created_at))throw Error('Cancelled gate lacks authenticated failure provenance');
 }
 const receipts=(await c.query("select action_type,target,receipt_hash,metadata from action_receipts where run_id=$1 and action_type in ('file_write','file_delete','file_patch','external_action') order by created_at,receipt_hash limit 1001",[input.runId])).rows;
 const artifacts=(await c.query("select uri,kind,content from artifacts where run_id=$1 and kind in ('file_write','file_patch','executor_output') order by uri limit 1001",[input.runId])).rows;
 const roots=[...new Set(receipts.map(r=>typeof r.metadata?.absolutePath==='string'&&relative(r.target)
  ?r.metadata.absolutePath.slice(0,-r.target.length-1):''))];
 const projects=(await c.query(`select p.id::text,p.root_uri from projects p where p.root_uri=any($1::text[]) and exists(select 1 from project_identity_locations l
  where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') order by p.id for share of p`,[roots])).rows;
 for(const p of projects)if(await fs.realpath(p.root_uri)!==p.root_uri)throw Error('Historical effect project is not canonical');
 const effects=qualifiedVerifierEffects(receipts,artifacts,projects);
 if(!exact(effects,grant.reviewedEffects))throw Error('Complete project-qualified historical source review required');
 const sideEffects=(await c.query('select s.* from side_effect_receipts s where project_id=any($1::text[]) order by to_jsonb(s)::text for update',[[input.runId,q.project_key]])).rows;
 if(sideEffects.some(s=>s.status!=='completed')||acceptanceDigest(sideEffects)!==grant.sideEffectSnapshotDigest)throw Error('Unresolved or changed side-effect reservation');
 const archives=(await c.query("select receipt_hash from action_receipts where run_id=$1 and action_type='failed_run_dismissed' order by receipt_hash",[input.runId])).rows.map(r=>r.receipt_hash);
 if(!exact(archives,grant.reviewedArchiveReceiptHashes))throw Error('View-only archival history requires explicit acknowledgement');
 const {queueWorkingOccupancyOnClient}=await import('./queue-coordinator.js');
 if((await queueWorkingOccupancyOnClient(c)).count>=5)throw Error('Working capacity is full');
 return {authorizationUri:input.verifierReassessment.authorizationUri,grantDigest:acceptanceDigest(grant),ptyCommands:grant.ptyCommands,
  candidateId:grant.candidateId,candidateDigest:grant.candidateDigest,effects,sourceHash:grant.sourceHash,taskSnapshotDigest:grant.taskSnapshotDigest,archiveReceiptHashes:archives};
}
