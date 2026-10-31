import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { renderDashboardQuestionPanel } from "./question-chat.js";
import { partnerChatHistory } from './partner-chat-state.js';

const render=()=>renderDashboardQuestionPanel([{id:"project-one",name:"Project One",rootUri:"/synthetic/one"}],"/synthetic/one");

test('run context is bounded evidence and never a project or action authority',()=>{
 const runId='11111111-1111-4111-8111-111111111111';
 const html=renderDashboardQuestionPanel([{id:'one',name:'One',rootUri:'/synthetic/one'}],'/synthetic/one',{runId});
 assert.ok(html.includes(`data-partner-run="${runId}"`));
 assert.match(html,/message:question,conversationId:chat.id/);
 assert.match(html,/validRun\(chat.selectedRunId\)\?\{runId:chat.selectedRunId\}/);
 assert.match(html,/const validRun=value=>typeof value==='string'/);
 assert.doesNotMatch(html,/message:scopedQuestion/);
 assert.match(renderDashboardQuestionPanel([], '', {runId:'<script>'}),/data-partner-run=""/);
});

test("Partner is one accessible conversation with persistent chat and composer controls",()=>{
  const html=render();
  assert.match(html,/Queue Partner/u);
  assert.match(html,/aria-labelledby="dashboard-question-heading"/u);
  assert.match(html,/role="log" aria-live="polite"/u);
  for(const name of ['recent','new','thread','message','stop-wait','jump'])assert.ok(html.includes(`id="dashboard-question-${name}"`));
  assert.doesNotMatch(html,/dashboard-question-project|name="projectId"|project-one|synthetic/);
  assert.doesNotMatch(renderDashboardQuestionPanel([],''),/type="submit" disabled/);
  assert.doesNotMatch(html,/id="dashboard-question-(?:items|approve|work|stop-work|target)"|ops-question-prompts/);
  assert.match(html,/Approve and run this exact action/);
  assert.match(html,/>Send<\/button>/u);
  assert.match(html,/event.shiftKey/u);
  assert.match(html,/id="dashboard-question-thread"/u);
});

test("rendered queue partner script parses and all responses use text nodes",()=>{
  const html=render(),script=html.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  assert.ok(script);assert.doesNotThrow(()=>new Script(script));
  assert.match(script,/document.createTextNode/);
  assert.match(script,/node.textContent=text/);
  assert.match(script,/p.disclosure.length<=12000/);
  assert.doesNotMatch(script,/innerHTML|insertAdjacentHTML|document\.write/u);
  assert.match(script,/fetch\('\/api\/queue-partner-message'/u);
  assert.match(script,/'x-agentflow-queue-partner':'1'/u);
  assert.match(script,/conversationId:chat.id/);
  assert.doesNotMatch(script,/projectId[,}]/u);
  assert.match(script,/No automatic retry was performed/u);
  assert.match(script,/link.href='\/run\?id='\+encodeURIComponent\(turn.runId\)/u);
  assert.match(script,/Step-by-step agent history/);
  assert.doesNotMatch(script,/\/studio\?project=/u);
  assert.doesNotMatch(script,/operation\.runId|innerHTML/u);
});

test("optional page filters cannot clear or narrow the partner conversation",()=>{
  const html=render();
  assert.doesNotMatch(html,/project.addEventListener|selectedOptions|project.value/);
  assert.match(html,/if\(busy!==current\)return/u);
  assert.match(html,/restoreChats/);
  assert.match(html,/scope=validRun\(initialRun\)\?'run:'\+initialRun:'queue'/);
});

test("client history stays within server turn and character budgets",()=>{
  const turns:Array<{id:string;role:'user'|'assistant';text:string}>=[];
  for(let i=0;i<20;i++)turns.push({id:String(i),role:'user',text:'x'.repeat(4000)});
  let history=partnerChatHistory(turns);
  assert.equal(history.length,6);
  assert.equal(history.reduce((size,turn)=>size+turn.content.length,0),24000);
  turns.length=0;
  for(let i=0;i<20;i++)turns.push({id:String(i),role:'assistant',text:String(i)});
  history=partnerChatHistory(turns);
  assert.equal(history.length,10);
  assert.equal(history[0].content,"10");
});

test("untrusted project display and ID never inject markup or script",()=>{
  const attack='</option><script>alert("x")</script>';
  const html=renderDashboardQuestionPanel([{id:attack,name:attack,rootUri:"/synthetic"}],"/synthetic");
  assert.equal((html.match(/<script>/gu)??[]).length,1);
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('id="dashboard-question-thread"'));
  assert.ok(!html.includes("/queue?project="+encodeURIComponent(attack)));
});
