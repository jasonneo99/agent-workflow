import assert from "node:assert/strict";
import test from "node:test";
import { MemoryGraph, estimateTokens, recordStageOutcome } from "./memory-graph.js";

function buildSample(): MemoryGraph {
  const g = new MemoryGraph();
  const goal = g.addNode({ type: "goal", title: "Ship auth", body: "ship oauth" });
  const task = g.addNode({ type: "task", title: "Wire token refresh", body: "refresh tokens" });
  const evidence = g.addNode({ type: "evidence", title: "RFC-42", body: "refresh flow spec" });
  const artifact = g.addNode({ type: "artifact", title: "auth.ts", body: "export function refresh() {}" });
  const decision = g.addNode({ type: "decision", title: "Use rotating refresh", body: "rotating tokens" });
  const action = g.addNode({ type: "action", title: " Ran migration", body: "migration ran" });
  const result = g.addNode({ type: "result", title: "Refresh works", body: "tests green" });
  g.addEdge(goal.id, task.id, "decomposes");
  g.addEdge(evidence.id, task.id, "supports");
  g.addEdge(task.id, artifact.id, "produces");
  g.addEdge(task.id, decision.id, "decided_by");
  g.addEdge(task.id, action.id, "executes");
  g.addEdge(action.id, result.id, "leads_to");
  return g;
}

test("walk reaches related nodes ordered by path cost", () => {
  const g = buildSample();
  const goalId = [...(g as any).nodes.values()].find((n: any) => n.type === "goal").id;
  const hits = g.walk(goalId);
  const types = hits.map((h) => h.node.type);
  // goal -decomposes(1)-> task; task -decided_by(1)-> decision (cost 2); -produces(2)-> artifact (cost 3)
  assert.ok(types.includes("task"));
  assert.ok(types.includes("decision"));
  assert.ok(types.includes("artifact"));
  assert.equal(hits[0].node.type, "task");
  assert.match(hits[0].path, /goal -> decomposes -> task/);
});

test("walk skips superseded (stale) nodes", () => {
  const g = buildSample();
  const goalId = [...(g as any).nodes.values()].find((n: any) => n.type === "goal").id;
  const taskId = [...(g as any).nodes.values()].find((n: any) => n.type === "task").id;
  const stale = g.addNode({ type: "evidence", title: "Old RFC", body: "outdated" });
  const fresh = g.addNode({ type: "evidence", title: "New RFC", body: "current" });
  g.addEdge(taskId, stale.id, "relates");
  g.addEdge(taskId, fresh.id, "relates");
  g.addEdge(fresh.id, stale.id, "supersedes");
  const hits = g.walk(goalId, 10);
  assert.ok(!hits.some((h) => h.node.id === stale.id), "stale node should be skipped");
  assert.ok(hits.some((h) => h.node.id === fresh.id), "fresh node should be reachable");
});

test("walk respects maxCost", () => {
  const g = buildSample();
  const goalId = [...(g as any).nodes.values()].find((n: any) => n.type === "goal").id;
  const shallow = g.walk(goalId, 1);
  assert.deepEqual(shallow.map((h) => h.node.type), ["task"]);
});

test("walk on unknown seed returns empty", () => {
  const g = buildSample();
  assert.deepEqual(g.walk("nope"), []);
});

test("edges to unknown nodes throw", () => {
  const g = new MemoryGraph();
  const n = g.addNode({ type: "goal", title: "g", body: "g" });
  assert.throws(() => g.addEdge(n.id, "missing", "relates"));
  assert.throws(() => g.addEdge("missing", n.id, "relates"));
});

test("duplicate nodes throw; duplicate edges dedupe", () => {
  const g = new MemoryGraph();
  const n = g.addNode({ id: "x", type: "goal", title: "g", body: "g" });
  assert.throws(() => g.addNode({ id: "x", type: "goal", title: "g", body: "g" }));
  const m = g.addNode({ type: "task", title: "t", body: "t" });
  g.addEdge(n.id, m.id, "decomposes");
  g.addEdge(n.id, m.id, "decomposes");
  const hits = g.walk(n.id);
  assert.equal(hits.length, 1);
});

test("scoreHit prefers evidence over distant goals and decays with cost", () => {
  const g = buildSample();
  const goalId = [...(g as any).nodes.values()].find((n: any) => n.type === "goal").id;
  const hits = g.walk(goalId, 10);
  const byId = new Map(hits.map((h) => [h.node.id, h]));
  const evidence = hits.find((h) => h.node.type === "evidence")!;
  const scored = hits.map((h) => ({ type: h.node.type, score: g.scoreHit(h) }));
  const evScore = g.scoreHit(evidence);
  const taskScore = g.scoreHit(byId.get(hits.find((h) => h.node.type === "task")!.node.id)!);
  assert.ok(evScore > 0 && taskScore > 0);
  // evidence (weight 1.0) reached via supports(1) from task path vs task itself (weight 0.5, cost 1)
  assert.ok(evScore > taskScore, `evidence ${evScore} should beat task ${taskScore}`);
});

test("serialize/deserialize round-trips the graph", () => {
  const g = buildSample();
  const json = g.serialize();
  const g2 = MemoryGraph.deserialize(json);
  assert.equal(g2.size, g.size);
  const goalId = [...(g2 as any).nodes.values()].find((n: any) => n.type === "goal").id;
  const hits = g2.walk(goalId);
  assert.ok(hits.length > 0);
  assert.throws(() => MemoryGraph.deserialize(JSON.stringify({ version: 999, nodes: [], edges: [] })));
});

test("recordStageOutcome links goal -> task -> decision/result", () => {
  const g = new MemoryGraph();
  const { task, decision, result } = recordStageOutcome(g, {
    goalTitle: "Ship auth",
    taskTitle: "Wire token refresh",
    decisionSummary: "used local provider",
    resultSummary: "done"
  });
  assert.equal(g.size, 4);
  const goal = [...(g as any).nodes.values()].find((n: any) => n.type === "goal");
  const hits = g.walk(goal.id);
  const ids = new Set(hits.map((h) => h.node.id));
  assert.ok(ids.has(task.id) && ids.has(decision.id) && ids.has(result.id));
  // reusing the goal id keeps one goal
  recordStageOutcome(g, {
    goalId: goal.id,
    goalTitle: "Ship auth",
    taskTitle: "Second task",
    decisionSummary: "d2",
    resultSummary: "r2"
  });
  assert.equal([...(g as any).nodes.values()].filter((n: any) => n.type === "goal").length, 1);
});

test("estimateTokens is stable and positive", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});
