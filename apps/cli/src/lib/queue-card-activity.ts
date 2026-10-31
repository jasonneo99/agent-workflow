import {withClient} from '../../../../packages/storage/src/client.js';
import {sanitizeAssistantText} from '../../../../packages/conversation-contract/src/index.js';

export interface QueueCardActivity {text:string;runId:string;observedAt:string|null;current:boolean}
export interface ActivityQueueItem {runId:string;runStatus:string;projectRootUri:string;runningStageId?:string|null;blockedReason?:string|null;failedReason?:string|null;familyAttempts?:Array<{id:string;status:string}>}
export interface CardReceipt {runId:string;rootUri:string;runStatus:string;leaseExpiresAt:string|null;action:string;target:string;createdAt:string;metadata:Record<string,unknown>}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const actions=['execution_progress','file_read','file_search','file_write','file_write_rejected','local_command','stage_started','stage_completed','stage_blocked','stage_failed','model_route','model_route_failed','commit_created'];
const clean=(value:unknown,max=220)=>sanitizeAssistantText(typeof value==='string'?value:'',max).replace(/\s+/gu,' ').trim();
function file(value:unknown){const p=clean(value);return !p||p.startsWith('/')||p.includes('\\')||p.split('/').includes('..')||/(^|\/)(?:\.env(?:\..*)?|credentials?|secrets?)(\/|$)/iu.test(p)?'[protected path]':p;}
function command(value:unknown){const s=clean(value);if(/^(?:python3? -m (?:unittest|compileall)|npm (?:run [a-z0-9:_-]+|test)|node --test|git diff --check)(?:\s|$)/u.test(s))return s.replace(/(?:\s--?(?:token|password|key|secret)[=\s]).*/iu,' [protected arguments]').replace(/\/(?:Users|home|tmp)\/\S+/gu,'[local path]');const executable=s.split(/\s/u)[0];return /^[a-z0-9][a-z0-9._-]*$/iu.test(executable??'')?`approved ${executable} command`:'approved command';}
export function cardActivity(item:ActivityQueueItem,receipts:CardReceipt[],now=Date.now()):QueueCardActivity{
 const family=new Set([item.runId,...(item.familyAttempts??[]).map(a=>a.id)]);
 const eligible=receipts.filter(r=>family.has(r.runId)&&r.rootUri===item.projectRootUri&&Number.isFinite(Date.parse(r.createdAt)));
 const active=eligible.filter(r=>['running','leased'].includes(r.runStatus));
 const r=[...(active.length?active:eligible)].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
 const fallback=item.runStatus==='blocked'?'Blocked — '+clean(item.blockedReason||'waiting for required evidence or permission'):item.runStatus==='failed'?'Failed — '+clean(item.failedReason||'inspect the recorded failure'):item.runStatus==='completed'?'Execution ended — acceptance still requires verification':item.runStatus==='queued'?'Queued — waiting for a worker':'Waiting for a recorded action';
 if(!r)return {text:fallback,runId:item.runId,observedAt:null,current:false};
 const m=r.metadata??{},fresh=['running','leased'].includes(r.runStatus)&&Date.parse(r.leaseExpiresAt??'')>now&&now-Date.parse(r.createdAt)<120000;
 let text:string,current=false;
 switch(r.action){
  case 'execution_progress':current=fresh;text=(fresh?'Now: ':'Last started: ')+(m.operation==='agent'?'agent processing '+clean(r.target,80)+' — awaiting recorded tool activity':m.operation==='file_write'?'applying changes to '+file(r.target):'running '+command(r.target));if(!fresh)text+=' — awaiting a result';break;
  case 'file_read':text='Read '+file(r.target);break;
  case 'file_search':text='Searched project source';break;
  case 'file_write':text=(typeof m.nextHash==='string'&&m.nextHash!==m.previousHash?'Changed ':'Write recorded: ')+file(r.target);break;
  case 'file_write_rejected':text='Change rejected: '+file(r.target);break;
  case 'local_command':text=m.exitCode===0&&/^git commit(?:\s|$)/u.test(r.target)?'Commit command completed — inspect its recorded result':(m.timedOut===true?'Timed out: ':m.exitCode===0?'Passed: ':typeof m.exitCode==='number'?'Failed: ':'Result recorded: ')+command(r.target);break;
  case 'commit_created':text=typeof m.commitHash==='string'&&/^[a-f0-9]{40,64}$/u.test(m.commitHash)?'Recorded commit '+m.commitHash.slice(0,12):'Commit reported — hash not verified';break;
  case 'stage_started':text='Stage started — waiting for its next recorded action';break;
  case 'stage_completed':text='Stage finished — next acceptance gate remains separate';break;
  case 'stage_blocked':text='Recorded blocker — '+clean(m.reason||item.blockedReason||'inspect the required evidence or permission');break;
  case 'stage_failed':text='Recorded failure — '+clean(m.reason||item.failedReason||'inspect the failure evidence');break;
  case 'model_route_failed':text='Agent call failed — inspect provider evidence';break;
  default:text='Agent response recorded — evaluating requested actions';
 }
 if(!current&&!['running','leased','queued'].includes(item.runStatus)&&!['stage_blocked','stage_failed'].includes(r.action))text='Last action: '+text;
 return {text:clean(text,320),runId:r.runId,observedAt:r.createdAt,current};
}
export async function withQueueCardActivity<T extends ActivityQueueItem>(items:T[]):Promise<Array<T&{liveActivity:QueueCardActivity}>>{
 const ids=[...new Set(items.flatMap(i=>[i.runId,...(i.familyAttempts??[]).map(a=>a.id)]).filter(id=>uuid.test(id)))].slice(0,1000);
 let receipts:CardReceipt[];
 try {receipts=ids.length?await withClient(async c=>(await c.query<CardReceipt>(`select distinct on (a.run_id) a.run_id::text as "runId",p.root_uri as "rootUri",r.status as "runStatus",r.lease_expires_at::text as "leaseExpiresAt",
 a.action_type as action,left(a.target,500) target,a.created_at::text as "createdAt",
 jsonb_build_object('operation',a.metadata->'operation','exitCode',a.metadata->'exitCode','timedOut',a.metadata->'timedOut',
 'previousHash',a.metadata->'previousHash','nextHash',a.metadata->'nextHash','commitHash',a.metadata->'commitHash','reason',left(a.metadata->>'reason',500)) metadata
 from action_receipts a join workflow_runs r on r.id=a.run_id join projects p on p.id=r.project_id
 where a.run_id=any($1::uuid[]) and a.action_type=any($2::text[]) order by a.run_id,a.created_at desc,a.id desc`,[ids,actions])).rows):[];}
 catch {return items.map(item=>({...item,liveActivity:{text:'Activity unavailable — inspect run history',runId:item.runId,observedAt:null,current:false}}));}
 return items.map(item=>({...item,liveActivity:cardActivity(item,receipts)}));
}
