import type {Client} from 'pg';
import {loadProjectConfig} from '../../agent-registry/src/loaders.js';
import {resolveExecutionPolicy} from '../../policy-engine/src/index.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {acceptanceDigest} from './acceptance.js';

/** Operator-only prospective capability adoption. This is deliberately not a
 * general policy refresh: only exact already-allowed isolated PTY checks. */
export async function inspectExecutionRecipeAdoption(c:Client,input:{runId:string;commands:string[];executionRecipe?:{failedCommandUri:string;commands:string[]}},q:any,run:any) {
 const request=input.executionRecipe;
 if(!request)return undefined;
 if(q.state!=='held'||q.role!=='repair'||q.prior_child!==input.runId||run.status!=='failed'
  ||!run.evaluation_metadata?.existingAssignmentReconciliationUri
  ||!request.commands.length||new Set(request.commands).size!==request.commands.length
  ||request.commands.some(command=>!input.commands.includes(command)))throw Error('Exact failed same-assignment recipe review required');
 if((await c.query("select 1 from action_receipts where run_id=$1 and action_type='existing_assignment_recipe_resumed' limit 1",[input.runId])).rowCount)throw Error('One-time execution recipe adoption already consumed');
 const frozen=run.policy_snapshot.actions;
 if(frozen.isolate_command_writes!==true||frozen.allowed_write_paths?.length)throw Error('Recipe adoption requires existing read-only isolation');
 const current=resolveExecutionPolicy(await loadProjectConfig(q.root_uri),run.policy_profile).project;
 for(const command of input.commands){assertCommandAllowed(command,current);if(!frozen.allowed_commands.includes(command))throw Error('Recipe cannot add executable commands');}
 for(const command of request.commands)if(!current.actions.scoped_native_pty_commands?.includes(command)
  ||frozen.scoped_native_pty_commands?.includes(command))throw Error('Exact newly configured PTY recipe required');
 const rows=(await c.query(`select a.content,a.task_id::text from artifacts a
  join workflow_tasks t on t.id=a.task_id and t.run_id=a.run_id and t.status='failed'
  where a.run_id=$1 and a.uri=$2 and a.kind='command_output'
  and exists(select 1 from action_receipts r where r.run_id=a.run_id and r.action_type='local_command'
   and r.target=a.content->>'commandLine' and r.metadata=a.content and r.receipt_hash is not null)
  and not exists(select 1 from artifacts newer where newer.run_id=a.run_id and newer.task_id=a.task_id
   and newer.kind='command_output' and newer.created_at>a.created_at)`,[input.runId,request.failedCommandUri])).rows;
 const failure=rows[0]?.content;
 if(rows.length!==1||failure.exitCode!==1||failure.timedOut!==false||!request.commands.includes(failure.commandLine)
  ||failure.requestedByTaskId!==rows[0].task_id||!failure.sourceBefore||failure.sourceBefore!==failure.sourceAfter
  ||failure.sourceBefore!==failure.subjectHash||failure.subjectHash!==run.evaluation_metadata.coordinatorReconciliationContract?.subjectHash
  ||!/Native PTY allocation failed: errno=(?:1|13)\b/u.test(`${failure.stdout}\n${failure.stderr}`)
  ||!/FAILED \(failures=1(?:, skipped=\d+)?\)/u.test(failure.stderr??''))throw Error('Latest task-bound isolated PTY denial evidence required');
 // The whole current config participates in preview CAS. Only the exact recipe
 // delta is adopted; every historical policy and failure stays in the record.
 return {failedCommandUri:request.failedCommandUri,failureHash:acceptanceDigest(failure),taskId:rows[0].task_id,
  currentPolicyHash:acceptanceDigest(current),commands:request.commands};
}
