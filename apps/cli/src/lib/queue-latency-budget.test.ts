import assert from "node:assert/strict";
import test from "node:test";
import {queueLatencyBudget} from "./queue-latency-budget.js";

const base={runStatus:"running",workflowId:"build-feature",runningTasks:1,queuedTasks:0,runningStageId:"frontend",nextStageId:null,oldestRunningAt:"2026-10-26T10:00:00Z",oldestQueuedAt:null,latestActivityAt:"2026-10-26T10:00:00Z",startedAt:"2026-10-26T09:59:00Z"};

test("warns before a standard running stage exhausts its budget",()=>{
 const budget=queueLatencyBudget(base,Date.parse("2026-10-26T10:08:30Z"));
 assert.equal(budget.phase,"running: frontend");assert.equal(budget.workClass,"standard");assert.equal(budget.status,"warning");assert.equal(budget.budgetMs,600_000);
});

test("uses larger budgets for verification and recovery work",()=>{
 assert.equal(queueLatencyBudget({...base,runningStageId:"independent-verification"}).budgetMs,900_000);
 assert.equal(queueLatencyBudget({...base,workflowId:"debug-failure",runningStageId:"diagnose"}).budgetMs,1_200_000);
});

test("preserves the authoritative waiting reason budget and exact phase",()=>{
 const budget=queueLatencyBudget({...base,runningTasks:0,queuedTasks:1,waitReason:{category:"intent-conflict",waitedMs:61_000,budgetMs:60_000}},0);
 assert.equal(budget.phase,"waiting: intent-conflict");assert.equal(budget.status,"overdue");assert.equal(budget.elapsedMs,61_000);
});

test("blocked and failed work gets a bounded decision phase",()=>{
 const budget=queueLatencyBudget({...base,runStatus:"blocked",runningTasks:0,latestActivityAt:"2026-10-26T10:00:00Z"},Date.parse("2026-10-26T10:05:01Z"));
 assert.equal(budget.workClass,"operator");assert.equal(budget.status,"overdue");assert.match(budget.phase,/blocked/);
});
