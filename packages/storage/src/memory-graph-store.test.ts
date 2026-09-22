import assert from "node:assert/strict";
import test from "node:test";
import { MemoryGraph, recordStageOutcome } from "./memory-graph.js";
import {
  deleteMemoryGraph,
  hasStageRecord,
  loadMemoryGraph,
  saveMemoryGraph
} from "./memory-graph-store.js";

const PROJECT = `test-memory-graph-${Date.now()}`;

test("memory graph store round-trips a project graph", async () => {
  const graph = new MemoryGraph();
  recordStageOutcome(graph, {
    goalTitle: "Ship the feature",
    taskTitle: "Implement the endpoint",
    decisionSummary: "routed to fast tier",
    resultSummary: "endpoint live",
    metadata: { taskId: "task-1" },
    nodeIds: { task: "task:task-1", decision: "decision:task-1", result: "result:task-1" }
  });

  const saved = await saveMemoryGraph(PROJECT, graph);
  assert.equal(saved.nodes, 4);
  assert.equal(saved.edges, 3);

  const loaded = await loadMemoryGraph(PROJECT);
  const task = loaded.getNode("task:task-1");
  assert.ok(task);
  assert.equal(task.title, "Implement the endpoint");
  assert.equal(task.metadata.taskId, "task-1");
  assert.ok(loaded.getNode("decision:task-1"));
  assert.ok(loaded.getNode("result:task-1"));

  // Walk still works after a persist/load cycle: from the task we reach
  // its decision and result (the goal edge is not reverse-traversable by design).
  const hits = loaded.walk("task:task-1", 8, 10);
  const types = new Set(hits.map((hit) => hit.node.type));
  assert.ok(types.has("decision"));
  assert.ok(types.has("result"));

  await deleteMemoryGraph(PROJECT);
  const empty = await loadMemoryGraph(PROJECT);
  assert.equal(empty.walk("task:task-1", 8, 10).length, 0);
});

test("memory graph save is idempotent per task", async () => {
  const project = `${PROJECT}-idem`;
  const build = () => {
    const graph = new MemoryGraph();
    recordStageOutcome(graph, {
      goalId: `run-goal:${project}`,
      goalTitle: "Ship the feature",
      taskTitle: "Implement the endpoint",
      decisionSummary: "routed to fast tier",
      resultSummary: "endpoint live",
      metadata: { taskId: "task-9" },
      nodeIds: { task: "task:task-9", decision: "decision:task-9", result: "result:task-9" }
    });
    return graph;
  };

  assert.equal(await hasStageRecord(project, "task-9"), false);
  await saveMemoryGraph(project, build());
  assert.equal(await hasStageRecord(project, "task-9"), true);

  // Recording the same stage again upserts the same rows: still 4 nodes.
  await saveMemoryGraph(project, build());
  const loaded = await loadMemoryGraph(project);
  const tasks = loaded.walk(`run-goal:${project}`, 8, 20).filter((hit) => hit.node.type === "task");
  assert.equal(tasks.length, 1);

  await deleteMemoryGraph(project);
});

test("loadMemoryGraph returns an empty graph for unknown projects", async () => {
  const loaded = await loadMemoryGraph(`test-memory-graph-missing-${Date.now()}`);
  assert.equal(loaded.walk("nope", 8, 10).length, 0);
});
