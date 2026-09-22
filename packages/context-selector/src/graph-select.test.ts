import assert from "node:assert/strict";
import test from "node:test";
import { MemoryGraph } from "../../storage/src/memory-graph.js";
import { selectFromMemoryGraph } from "./index.js";

function buildGraph(): { graph: MemoryGraph; goalId: string } {
  const graph = new MemoryGraph();
  const goal = graph.addNode({ type: "goal", title: "Ship auth", body: "oauth rollout" });
  const task = graph.addNode({ type: "task", title: "Wire token refresh", body: "refresh tokens" });
  const evidence = graph.addNode({ type: "evidence", title: "RFC-42 refresh spec", body: "rotating refresh tokens" });
  const artifact = graph.addNode({ type: "artifact", title: "auth.ts", body: "export function refresh() {}" });
  const stale = graph.addNode({ type: "evidence", title: "Old draft", body: "superseded draft" });
  graph.addEdge(goal.id, task.id, "decomposes");
  graph.addEdge(evidence.id, task.id, "supports");
  graph.addEdge(task.id, artifact.id, "produces");
  graph.addEdge(task.id, stale.id, "relates");
  graph.addEdge(evidence.id, stale.id, "supersedes");
  return { graph, goalId: goal.id };
}

test("selectFromMemoryGraph walks from the seed and respects the token budget", () => {
  const { graph, goalId } = buildGraph();
  const selected = selectFromMemoryGraph({ graph, seedId: goalId, maxTokens: 10_000 });
  const uris = selected.map((s) => s.sourceUri);
  assert.ok(uris.some((u) => u.startsWith("memory://node/")));
  // stale node never selected
  assert.ok(!selected.some((s) => s.summary.includes("Old draft")));
  // evidence reachable via reverse traversal of supports
  assert.ok(selected.some((s) => s.summary.includes("RFC-42")));
  for (const s of selected) {
    assert.match(s.selectionReason, /graph walk from seed/);
    assert.ok(s.score > 0);
  }
});

test("selectFromMemoryGraph boosts task-term overlap", () => {
  const { graph, goalId } = buildGraph();
  const withTask = selectFromMemoryGraph({ graph, seedId: goalId, task: "rotating refresh tokens", maxTokens: 10_000 });
  const withoutTask = selectFromMemoryGraph({ graph, seedId: goalId, maxTokens: 10_000 });
  const evWith = withTask.find((s) => s.summary.includes("RFC-42"))!;
  const evWithout = withoutTask.find((s) => s.summary.includes("RFC-42"))!;
  assert.ok(evWith.score > evWithout.score, "task overlap should boost the evidence score");
  assert.ok(evWith.matchedTerms.length > 0);
});

test("selectFromMemoryGraph honors maxNodes and maxTokens", () => {
  const { graph, goalId } = buildGraph();
  const few = selectFromMemoryGraph({ graph, seedId: goalId, maxNodes: 1, maxTokens: 10_000 });
  assert.equal(few.length, 1);
  const tiny = selectFromMemoryGraph({ graph, seedId: goalId, maxTokens: 1 });
  assert.ok(tiny.length <= 1);
});

test("selectFromMemoryGraph on unknown seed returns empty", () => {
  const { graph } = buildGraph();
  assert.deepEqual(selectFromMemoryGraph({ graph, seedId: "nope" }), []);
});
