import assert from "node:assert/strict";
import test from "node:test";
import {renderApprovalWait} from "./approval-waits.js";
import {queueLifecyclePresentation} from "./queue-lifecycle.js";
import {withQueueWaitReasons} from "../lib/queue-wait-reasons.js";
import {queueLatencyBudget} from "../lib/queue-latency-budget.js";

const wait={taskId:'task',stageId:'implement',since:new Date().toISOString(),approvals:[{id:'approval',status:'pending',actionType:'local_command',target:'npm test',rationale:'Run the focused tests.',payload:{commandLine:'npm test'}}]};
test('held work has an exact actionable approval card and no failed lifecycle',async()=>{
 const html=renderApprovalWait(wait,type=>type==='local_command');
 assert.match(html,/Awaiting approval/);assert.match(html,/Approve and continue/);assert.match(html,/Approve only/);assert.match(html,/Reject/);
 assert.match(html,/queue-card-callout queue-approval-request warn/);assert.match(html,/aria-label="Approval required"/);
 assert.match(html,/name="decision" value="approve_execute"/);assert.match(html,/name="approvalId" value="approval"/);assert.match(html,/Exact request/);
 assert.equal(queueLifecyclePresentation({runStatus:'running',queuedTasks:6,runningTasks:0,failedTasks:0,approvalWait:wait}).label,'Awaiting approval');
 const rows=await withQueueWaitReasons([{runId:'held',queuedTasks:6,runningTasks:0,approvalWait:wait}],'/unavailable');
 assert.equal(rows[0].waitReason?.category,'approval');assert.equal(rows[0].waitReason?.overdue,false);
 assert.equal(queueLatencyBudget({runStatus:'running',workflowId:'synthetic',queuedTasks:6,runningTasks:0,runningStageId:null,nextStageId:'implement',oldestQueuedAt:null,oldestRunningAt:null,latestActivityAt:wait.since,startedAt:wait.since,approvalWait:wait}).phase,'awaiting approval');
});
test('approve-only stays held with an explicit execute button; manual decisions get no generic execution button',()=>{
 assert.match(renderApprovalWait({...wait,approvals:[{...wait.approvals[0],status:'approved'}]},()=>true),/Execute and continue/);
 const manual=renderApprovalWait({...wait,approvals:[{...wait.approvals[0],actionType:'operator_history_assessment'}]},()=>false);
 assert.doesNotMatch(manual,/approve_execute|Execute and continue|Approve and continue/);assert.match(manual,/>Approve<\/button>/);
});
test('approval payloads and request labels cannot inject HTML or forms',()=>{
 const html=renderApprovalWait({...wait,stageId:'<img src=x>',approvals:[{...wait.approvals[0],id:'\"><form action="evil">',target:'<script>evil()</script>',payload:{value:'</pre><script>evil()</script>'}}]},()=>true);
 assert.doesNotMatch(html,/<script>|<img|action="evil"/);assert.match(html,/&lt;script&gt;/);
 assert.equal(renderApprovalWait(null,()=>true),'');
});
