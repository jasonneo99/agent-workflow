import { partnerChatHistory, restorePartnerChats } from './partner-chat-state.js';
import { installPartnerWorkTrail, mergePartnerWorkSteps } from './partner-work-trail.js';

export function dashboardPartnerChatScript(): string {
  return `<script>(()=>{const __name=fn=>fn;const restoreChats=${restorePartnerChats.toString()},historyFor=${partnerChatHistory.toString()},createWorkTrail=${installPartnerWorkTrail.toString()},mergeWorkSteps=${mergePartnerWorkSteps.toString()};${clientScript()}})()</script>`;
}

function clientScript(): string { return String.raw`
const byId=id=>document.getElementById('dashboard-question-'+id),form=byId('form'),thread=byId('thread'),status=byId('status'),message=byId('message'),recent=byId('recent'),newChat=byId('new'),stopWait=byId('stop-wait'),jump=byId('jump'),storageNote=byId('storage');
if(!form||!thread||!status||!message||!recent||!newChat||!stopWait||!jump)return;
const validRun=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value),newId=()=>crypto.randomUUID(),initialRun=form.closest('[data-partner-run]')?.dataset.partnerRun||null,scope=validRun(initialRun)?'run:'+initialRun:'queue',storageKey='agentflow.partner.chats.v1:'+scope;
let store=null,storageAvailable=true,busy=null,outbox=[],lastItems=[],latestQueue=[],retryEntries=new Map();
try{store=restoreChats(localStorage.getItem(storageKey),scope)}catch{storageAvailable=false}
const createThread=()=>({id:newId(),title:'New conversation',draft:'',turns:[],selectedRunId:validRun(initialRun)?initialRun:null,proposal:null,workRefs:validRun(initialRun)?[{runId:initialRun,anchorTurnId:null}]:[],updatedAt:Date.now()});
if(!store){const first=createThread();store={version:1,scope,activeId:first.id,threads:[first]}}
const active=()=>store.threads.find(chat=>chat.id===store.activeId),find=id=>store.threads.find(chat=>chat.id===id);
const trim=chat=>{while(chat.turns.length>48||JSON.stringify(chat).length>96000){if(!chat.turns.length)break;chat.turns.shift()}};
const save=()=>{for(const chat of store.threads)trim(chat);try{localStorage.setItem(storageKey,JSON.stringify(store));storageAvailable=true}catch{storageAvailable=false}if(storageNote)storageNote.textContent=storageAvailable?'Saved in this browser':'Browser history storage is unavailable. Keep this tab open to retain this conversation.'};
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node};
const safeLink=value=>{try{const url=new URL(value,location.origin);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null}catch{return null}};
const inline=(parent,text)=>{const pattern=/\[([^\]\n]{1,200})\]\(([^\s)]{1,1800})\)|\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*/g;let start=0;for(const match of text.matchAll(pattern)){parent.append(document.createTextNode(text.slice(start,match.index)));if(match[1]){const href=safeLink(match[2]);if(href){const a=el('a',match[1]);a.href=href;a.target='_blank';a.rel='noopener noreferrer';parent.append(a)}else parent.append(document.createTextNode(match[0]))}else parent.append(el(match[3]?'code':'strong',match[3]||match[4]));start=match.index+match[0].length}parent.append(document.createTextNode(text.slice(start)))};
const rich=(parent,text)=>{const lines=String(text).slice(0,12000).split('\n');let code=null,list=null;for(const line of lines){if(line.startsWith('\x60\x60\x60')){if(code){parent.append(code);code=null}else{code=el('pre',undefined,'ops-chat-code');code.append(el('code',''));}list=null;continue}if(code){code.firstElementChild.textContent+=line+'\n';continue}if(/^\s*[-*] /.test(line)||/^\s*\d+\. /.test(line)){if(!list){list=el(/^\s*\d/.test(line)?'ol':'ul');parent.append(list)}const li=el('li');inline(li,line.replace(/^\s*(?:[-*]|\d+\.)\s+/,''));list.append(li)}else{list=null;if(line.trim()){const p=el(/^#{1,3} /.test(line)?'h4':'p');inline(p,line.replace(/^#{1,3} /,''));parent.append(p)}}}if(code)parent.append(code)};
const setStatus=value=>{status.textContent=value};
const proposalFor=chat=>{const p=chat.proposal;return p&&p.runId===chat.selectedRunId&&p.conversationId===chat.id&&Date.parse(p.expiresAt)>Date.now()&&chat.turns.some(turn=>turn.proposalId===p.id&&turn.runId===p.runId&&turn.disclosure===p.disclosure)?p:null};

const selection=()=>{document.dispatchEvent(new CustomEvent('queue-partner-chat-selection',{detail:{runId:active().selectedRunId}}))};
const bindWork=(chat,runId,anchor=null)=>{if(!validRun(runId))return;chat.workRefs=chat.workRefs||[];if(!chat.workRefs.some(ref=>ref.runId===runId))chat.workRefs.push({runId,anchorTurnId:anchor});chat.workRefs=chat.workRefs.slice(-3)};
const mountWork=createWorkTrail(mergeWorkSteps,runId=>{active().selectedRunId=runId;active().proposal=null;send('Stop work')});
const renderRecent=()=>{recent.replaceChildren();for(const chat of store.threads){const option=el('option',chat.title||'New conversation');option.value=chat.id;recent.append(option)}recent.value=store.activeId};
const scrollLatest=()=>{thread.scrollTop=thread.scrollHeight;jump.hidden=true};
const render=()=>{const top=thread.scrollTop,nearBottom=thread.scrollHeight-thread.scrollTop-thread.clientHeight<100,chat=active(),mounts=[],seenWork=new Set();thread.replaceChildren();
const workAt=(parent,ref)=>{const host=el('div');parent.append(host);mounts.push([ref.runId,host]);seenWork.add(ref.runId)};
if(!chat.turns.length){const welcome=el('article',undefined,'ops-question-turn assistant');welcome.append(el('strong','Partner'));if(latestQueue.length){welcome.append(el('p',"Here’s what is happening."));for(const item of latestQueue.slice(0,3)){const line=el('p');line.textContent=activityText(item);welcome.append(line);const follow=el('button','Follow this work','ops-chat-inline-action');follow.type='button';follow.addEventListener('click',()=>{chat.selectedRunId=item.runId;bindWork(chat,item.runId);render();message.focus()});welcome.append(follow)}}else{welcome.append(el('p','What would you like to work on?'))}thread.append(welcome)}
for(const turn of chat.turns){const article=el('article',undefined,'ops-question-turn '+turn.role);article.dataset.turnId=turn.id;const head=el('header');head.append(el('strong',turn.role==='user'?'You':'Partner'),el('small',turn.state==='queued'?'Queued message':turn.state==='sending'?'Sending…':turn.state==='unconfirmed'?'Outcome unconfirmed · not resent':turn.detail||''));article.append(head);const body=el('div',undefined,'ops-chat-body');rich(body,turn.text);article.append(body);
if(turn.disclosure){const disclosure=el('details');disclosure.open=true;disclosure.append(el('summary','Exact action and full payload'),el('pre',turn.disclosure,'ops-question-approval-payload'));article.append(disclosure);const p=proposalFor(chat);if(p&&p.id===turn.proposalId){const approve=el('button','Approve and run this exact action','ops-chat-inline-approve');approve.type='button';approve.disabled=Boolean(busy||outbox.length);approve.addEventListener('click',()=>{if(proposalFor(chat)?.id===turn.proposalId&&!busy)send('Approved')});article.append(approve)}}
for(const item of turn.items||[]){const follow=el('button',(chat.selectedRunId===item.runId?'Following: ':'Follow: ')+item.title,'ops-chat-inline-action');follow.type='button';follow.addEventListener('click',()=>{chat.selectedRunId=item.runId;chat.proposal=null;bindWork(chat,item.runId,turn.id);render();message.focus()});article.append(follow)}
if(turn.role==='assistant'){const copy=el('button','Copy reply','ops-chat-copy');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(turn.text);copy.textContent='Copied'}catch{copy.textContent='Copy unavailable'}});article.append(copy)}
if(validRun(turn.runId)){const link=el('a','View run');link.href='/run?id='+encodeURIComponent(turn.runId);article.append(link)}
for(const ref of chat.workRefs||[])if(ref.anchorTurnId===turn.id&&!seenWork.has(ref.runId))workAt(article,ref);const retryEntry=retryEntries.get(turn.id);if(retryEntry){const retry=el('button','Retry the same message','ops-chat-retry');retry.type='button';retry.addEventListener('click',()=>{if(busy)return;retryEntries.delete(turn.id);retryEntry.turn.state='queued';outbox.push(retryEntry);void drain()});article.append(retry)}thread.append(article)}
for(const ref of chat.workRefs||[])if(!seenWork.has(ref.runId)){const article=el('article',undefined,'ops-question-turn assistant');workAt(article,ref);thread.append(article)}
if(busy?.chatId===chat.id){const pending=el('div','Partner is responding…','ops-chat-pending');pending.setAttribute('role','status');thread.append(pending)}
renderRecent();selection();for(const [id,host]of mounts)mountWork(id,host);if(nearBottom||!chat.turns.length)scrollLatest();else{thread.scrollTop=top;jump.hidden=false}stopWait.hidden=!busy;save()};
const renderItems=values=>{lastItems=Array.isArray(values)?values.slice(0,6).filter(item=>validRun(item?.runId)).map(item=>({runId:item.runId,title:String(item.title||'Work item').slice(0,160),status:String(item.status||'').slice(0,30)})):[]};
const append=(chat,role,text,extra={})=>{const turn={id:newId(),role,text:String(text).slice(0,12000),state:'complete',...extra};chat.turns.push(turn);chat.updatedAt=Date.now();trim(chat);if(chat.id===store.activeId)render();else save();return turn};
const responseStatus={answered:'Ready','needs-selection':'Choose an item','needs-approval':'Approval needed',queued:'Agents queued',requested:'Request recorded',completed:'Action recorded',blocked:'Needs attention',review:'Check the recorded outcome'};
async function drain(){if(busy||!outbox.length)return;const entry=outbox.shift(),chat=find(entry.chatId);if(!chat){void drain();return}const controller=new AbortController(),current={...entry,controller};busy=current;entry.turn.state='sending';if(!entry.body.history)entry.body.history=historyFor(chat.turns);if(chat.id===store.activeId){render();setStatus('Queue Partner is responding…')}else save();
try{const response=await fetch('/api/queue-partner-message',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',accept:'application/json','x-agentflow-queue-partner':'1'},body:JSON.stringify(entry.body)}),result=await response.json();if(busy!==current)return;if(!result||result.kind!=='queue_partner_chat_report'||typeof result.text!=='string')throw Error('Invalid partner response');entry.turn.state='complete';if(validRun(result.selectedRunId)&&chat.selectedRunId===(entry.body.runId||null)){if(chat.selectedRunId!==result.selectedRunId)chat.proposal=null;chat.selectedRunId=result.selectedRunId}const p=result.proposal,disclosed=result.status==='needs-approval'&&p&&validRun(p.id)&&p.conversationId===chat.id&&p.runId===chat.selectedRunId&&typeof p.disclosure==='string'&&p.disclosure.length<=12000&&Date.parse(p.expiresAt)>Date.now();if(disclosed)chat.proposal={id:p.id,runId:p.runId,conversationId:p.conversationId,disclosure:p.disclosure,expiresAt:p.expiresAt};else if(['queued','completed','requested','needs-approval','needs-selection'].includes(result.status)||entry.body.message==='Approved')chat.proposal=null;renderItems(result.items);const replyTurn=append(chat,'assistant',result.text,{detail:result.replayed?'Recorded result · not executed again':'Agent Workflow · Queue Partner',...(validRun(result.runId||result.selectedRunId)?{runId:result.runId||result.selectedRunId}:{}),...(disclosed?{disclosure:p.disclosure,proposalId:p.id}:{}),items:lastItems});if(validRun(result.runId)||disclosed)bindWork(chat,result.runId||result.selectedRunId,replyTurn.id);if(chat.id===store.activeId){render();setStatus(responseStatus[result.status]||'Needs attention')}}
catch{if(busy!==current)return;entry.turn.state='unconfirmed';const notice=append(chat,'assistant','The request outcome could not be confirmed. No automatic retry was performed. Review the selected run before retrying an action.',{detail:'Connection interrupted'});retryEntries.set(notice.id,entry);if(chat.id===store.activeId)setStatus('Outcome unconfirmed');for(const queued of outbox){queued.turn.state='cancelled';queued.turn.detail='Not sent after an unconfirmed result'}outbox=[];save()}
finally{if(busy===current){busy=null;stopWait.hidden=true;render();if(outbox.length)void drain();else if(chat.id===store.activeId)message.focus()}}}
const send=text=>{const chat=active(),question=String(text).trim().slice(0,4000);if(!question||outbox.length>=4)return;const body={message:question,conversationId:chat.id,idempotencyKey:'dashboard-'+newId(),...(validRun(chat.selectedRunId)?{runId:chat.selectedRunId}:{}),...(proposalFor(chat)?{proposalId:proposalFor(chat).id}:{})};if(!chat.turns.length)chat.title=question.slice(0,65);const turn=append(chat,'user',question,{state:'queued'});scrollLatest();outbox.push({chatId:chat.id,turn,body});chat.draft='';message.value='';save();setStatus(busy?'Message queued · you can keep writing':'Sending…');void drain()};
form.addEventListener('submit',event=>{event.preventDefault();send(message.value)});message.addEventListener('input',()=>{active().draft=message.value.slice(0,4000);save();message.style.height='auto';message.style.height=Math.min(180,message.scrollHeight)+'px'});message.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit()}});
stopWait.addEventListener('click',()=>{if(!busy)return;const current=busy;busy=null;current.controller.abort();current.turn.state='unconfirmed';append(find(current.chatId),'assistant','Stopped waiting for this reply. An action already sent may still finish; check its recorded run before sending it again.',{detail:'Waiting stopped'});for(const queued of outbox){queued.turn.state='cancelled';queued.turn.detail='Not sent after stopping'}outbox=[];stopWait.hidden=true;render();setStatus('Waiting stopped · review the run')});
newChat.addEventListener('click',()=>{active().draft=message.value;const chat=createThread();if(store.threads.length>=8){const removable=store.threads.findLastIndex(t=>t.id!==busy?.chatId&&!outbox.some(entry=>entry.chatId===t.id));if(removable<0)return;store.threads.splice(removable,1)}store.threads.unshift(chat);store.activeId=chat.id;message.value='';lastItems=[];render();setStatus('Ready');message.focus()});
recent.addEventListener('change',()=>{active().draft=message.value;store.activeId=recent.value;message.value=active().draft;lastItems=[];render();setStatus(busy?.chatId===active().id?'Queue Partner is responding…':'Ready');message.focus()});
jump.addEventListener('click',scrollLatest);thread.addEventListener('scroll',()=>{jump.hidden=thread.scrollHeight-thread.scrollTop-thread.clientHeight<100});
document.addEventListener('queue-partner-open',()=>{message.focus({preventScroll:true})});

const activityText=item=>[item.title,item.what,item.why?'Why: '+item.why:'',item.how?'How: '+item.how:'',item.next?'Next: '+item.next:'',item.requiresPermission?'Your approval is needed before this action.':'',item.state==='completed'?'Workflow finished; acceptance still depends on its evidence.':''].filter(Boolean).join('\n');
document.addEventListener('queue-partner-live-snapshot',event=>{
 const report=event.detail;if(report?.authority!=='evidence-only'||!Array.isArray(report.entries))return;
 latestQueue=report.entries.slice(0,6).filter(item=>validRun(item?.runId)).map(item=>({runId:item.runId,title:String(item.title||'Work').slice(0,180),what:String(item.what||'').slice(0,350),why:String(item.why||'').slice(0,350),how:String(item.how||'').slice(0,350),next:String(item.next||'').slice(0,350),requiresPermission:item.requiresPermission===true,state:String(item.state||'').toLowerCase()}));
 const chat=active(),queueWide=scope==='queue'&&!validRun(chat.selectedRunId);
 if(!chat.turns.length){
  if(!(chat.workRefs||[]).length){
   const followed=queueWide?latestQueue.slice(0,3):latestQueue.filter(item=>item.runId===chat.selectedRunId);
   for(const item of followed)bindWork(chat,item.runId);
  }
  render();
 }else for(const item of latestQueue){
  if(!queueWide&&item.runId!==chat.selectedRunId&&!(chat.workRefs||[]).some(ref=>ref.runId===item.runId))continue;
  const text=activityText(item),key=item.runId+':'+text;if(chat.turns.some(turn=>turn.activityKey===key))continue;
  const turn=append(chat,'assistant',text,{observation:true,activityKey:key,runId:item.runId,detail:'Recorded work update'});
  if(queueWide&&(chat.workRefs||[]).length<3){bindWork(chat,item.runId,turn.id);render();}
 }
});
let lastCheckText='';
document.addEventListener('queue-partner-check-observed',event=>{
 const target=byId('observation'),report=event.detail;if(!target||report?.authority!=='evidence-only')return;
 const check=report.coordinator,at=typeof check?.checkedAt==='string'?Date.parse(check.checkedAt):NaN;
 if(check?.version===1&&check.authority==='evidence-only'&&Number.isFinite(at)&&at<=Date.now()+5000
  &&Number.isInteger(check.inventory)&&check.inventory>=0&&check.inventory<=1000&&Number.isInteger(check.held)&&check.held>=0&&check.held<=check.inventory){
   const stale=check.stale===true||Date.now()-at>45000;
   lastCheckText=(stale?'No recent coordinator check. Last check ':'Last queue check ')+new Date(at).toLocaleTimeString()+' · '+check.inventory+' items · '+check.held+' held';
 }else lastCheckText='Queue feed connected · no completed Partner check recorded';
 target.textContent=lastCheckText;
});
document.addEventListener('queue-partner-activity-unavailable',()=>{const target=byId('observation');if(target)target.textContent='Live queue updates unavailable'+(lastCheckText?' · '+lastCheckText:'');});

window.addEventListener('pagehide',()=>{active().draft=message.value;save()});message.value=active().draft;render();setStatus(active().turns.some(turn=>turn.state==='unconfirmed')?'Previous outcome unconfirmed · not resent':'Ready');
`; }
