import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryContextForStage,
  buildStageOutcomeInput,
  formatMemoryContext,
  isMemoryGraphEnabled,
  memoryNodeIds,
  recordStageMemoryGraph
} from "./memory-graph-wiring.js";

test("memoryNodeIds are deterministic per task", () => {
  const first = memoryNodeIds("task-1");
  const second = memoryNodeIds("task-1");
  assert.deepEqual(first, second);
  assert.notEqual(memoryNodeIds("task-1").task, memoryNodeIds("task-2").task);
});

test("buildStageOutcomeInput shares one goal per run and tags the task", () => {
  const input = buildStageOutcomeInput({
    projectId: "run-1",
    taskId: "task-1",
    goalTitle: "Ship the feature",
    taskTitle: "Implement the endpoint",
    decisionSummary: "routed to fast tier",
    resultSummary: "endpoint live"
  });
  assert.equal(input.goalId, "run-goal:run-1");
  assert.equal(input.nodeIds?.task, "task:task-1");
  assert.equal(input.nodeIds?.decision, "decision:task-1");
  assert.equal(input.nodeIds?.result, "result:task-1");
  assert.equal(input.metadata?.taskId, "task-1");
});

test("formatMemoryContext renders prompt-ready lines", () => {
  const lines = formatMemoryContext([
    { summary: "Implement the endpoint: endpoint live", sourceUri: "memory://node/task:task-1" }
  ]);
  assert.deepEqual(lines, [
    "- Implement the endpoint: endpoint live (memory://node/task:task-1)"
  ]);
  assert.deepEqual(formatMemoryContext([]), []);
});

test("isMemoryGraphEnabled defaults on and honors the kill-switch", () => {
  const previous = process.env.AGENTFLOW_MEMORY_GRAPH;
  try {
    delete process.env.AGENTFLOW_MEMORY_GRAPH;
    assert.equal(isMemoryGraphEnabled(), true);
    process.env.AGENTFLOW_MEMORY_GRAPH = "0";
    assert.equal(isMemoryGraphEnabled(), false);
    process.env.AGENTFLOW_MEMORY_GRAPH = "1";
    assert.equal(isMemoryGraphEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_MEMORY_GRAPH;
    else process.env.AGENTFLOW_MEMORY_GRAPH = previous;
  }
});

test("buildMemoryContextForStage never throws and returns [] when disabled", async () => {
  const previous = process.env.AGENTFLOW_MEMORY_GRAPH;
  try {
    process.env.AGENTFLOW_MEMORY_GRAPH = "0";
    const context = await buildMemoryContextForStage({
      projectId: "run-missing",
      stageGoal: "do the thing",
      taskLabel: "workflow task"
    });
    assert.deepEqual(context, []);
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_MEMORY_GRAPH;
    else process.env.AGENTFLOW_MEMORY_GRAPH = previous;
  }
});

test("recordStageMemoryGraph never throws when disabled", async () => {
  const previous = process.env.AGENTFLOW_MEMORY_GRAPH;
  try {
    process.env.AGENTFLOW_MEMORY_GRAPH = "0";
    await recordStageMemoryGraph({
      projectId: "run-1",
      taskId: "task-1",
      goalTitle: "Ship the feature",
      taskTitle: "Implement the endpoint",
      decisionSummary: "routed",
      resultSummary: "done"
    });
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_MEMORY_GRAPH;
    else process.env.AGENTFLOW_MEMORY_GRAPH = previous;
  }
});

test("recordStageMemoryGraph never throws against an unreachable database", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousFlag = process.env.AGENTFLOW_MEMORY_GRAPH;
  try {
    process.env.DATABASE_URL = "postgres://127.0.0.1:1/unreachable";
    delete process.env.AGENTFLOW_MEMORY_GRAPH;
    await recordStageMemoryGraph({
      projectId: "run-1",
      taskId: "task-unreachable",
      goalTitle: "Ship the feature",
      taskTitle: "Implement the endpoint",
      decisionSummary: "routed",
      resultSummary: "done"
    });
    const context = await buildMemoryContextForStage({
      projectId: "run-1",
      stageGoal: "goal",
      taskLabel: "label"
    });
    assert.deepEqual(context, []);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousFlag === undefined) delete process.env.AGENTFLOW_MEMORY_GRAPH;
    else process.env.AGENTFLOW_MEMORY_GRAPH = previousFlag;
  }
});
