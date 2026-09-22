/**
 * AIR phase-3 spike: graph memory.
 *
 * Nodes: goal | task | evidence | artifact | decision | action | result.
 * Edges: decomposes | supports | produces | decided_by | executes | leads_to | supersedes | relates.
 *
 * This module is storage-agnostic on purpose: the graph serializes to plain
 * JSON, so it can live in a file, a postgres jsonb column, or the artifacts
 * table. The production path is a memory_nodes/memory_edges table pair; the
 * spike proves the graph shape and the graph-walking selection, not the
 * backend.
 *
 * Retraction semantics (from phase 1) carry over: a node targeted by a
 * `supersedes` edge from a newer node is stale and is skipped by walks.
 */

export type MemoryNodeType = "goal" | "task" | "evidence" | "artifact" | "decision" | "action" | "result";

export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  title: string;
  body: string;
  tokenEstimate: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export type MemoryEdgeType =
  | "decomposes"
  | "supports"
  | "produces"
  | "decided_by"
  | "executes"
  | "leads_to"
  | "supersedes"
  | "relates";

export interface MemoryEdge {
  from: string;
  to: string;
  type: MemoryEdgeType;
  /** Traversal cost; lower = closer relationship. */
  cost: number;
  createdAt: string;
}

export interface WalkHit {
  node: MemoryNode;
  /** Cheapest path cost from the seed. */
  cost: number;
  /** Human-readable path, e.g. "goal -> decomposes -> task -> produces -> artifact". */
  path: string;
}

const EDGE_COSTS: Record<MemoryEdgeType, number> = {
  decomposes: 1,
  supports: 1,
  produces: 2,
  decided_by: 1,
  executes: 2,
  leads_to: 3,
  supersedes: 1,
  relates: 4
};

/**
 * Edge types traversable backwards during a walk: the context flows opposite
 * to the edge direction. Evidence supports a task (evidence -> task), but a
 * walk seeded at the task must still reach its supporting evidence.
 */
const REVERSE_TRAVERSABLE: Set<MemoryEdgeType> = new Set(["supports"]);

const NODE_TYPE_WEIGHTS: Record<MemoryNodeType, number> = {
  evidence: 1.0,
  artifact: 0.9,
  decision: 0.8,
  result: 0.7,
  action: 0.6,
  task: 0.5,
  goal: 0.4
};

let idCounter = 0;
export function newNodeId(type: MemoryNodeType): string {
  idCounter += 1;
  return `mem_${type}_${Date.now().toString(36)}_${idCounter}`;
}

/** Rough token estimate; consistent and documented beats precise here. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface NewNodeInput {
  id?: string;
  type: MemoryNodeType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export class MemoryGraph {
  private nodes = new Map<string, MemoryNode>();
  private outEdges = new Map<string, MemoryEdge[]>();
  private superseded = new Set<string>();

  addNode(input: NewNodeInput): MemoryNode {
    const node: MemoryNode = {
      id: input.id ?? newNodeId(input.type),
      type: input.type,
      title: input.title,
      body: input.body,
      tokenEstimate: estimateTokens(`${input.title}\n${input.body}`),
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: input.metadata ?? {}
    };
    if (this.nodes.has(node.id)) throw new Error(`memory node ${node.id} already exists`);
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(from: string, to: string, type: MemoryEdgeType, cost?: number): MemoryEdge {
    if (!this.nodes.has(from)) throw new Error(`memory edge from unknown node ${from}`);
    if (!this.nodes.has(to)) throw new Error(`memory edge to unknown node ${to}`);
    const edge: MemoryEdge = {
      from,
      to,
      type,
      cost: cost ?? EDGE_COSTS[type],
      createdAt: new Date().toISOString()
    };
    const list = this.outEdges.get(from) ?? [];
    if (!list.some((e) => e.to === to && e.type === type)) list.push(edge);
    this.outEdges.set(from, list);
    if (type === "supersedes") this.superseded.add(to);
    return edge;
  }

  private incomingOf(id: string): MemoryEdge[] {
    const incoming: MemoryEdge[] = [];
    for (const edges of this.outEdges.values()) {
      for (const edge of edges) {
        if (edge.to === id) incoming.push(edge);
      }
    }
    return incoming;
  }

  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  isSuperseded(id: string): boolean {
    return this.superseded.has(id);
  }

  get size(): number {
    return this.nodes.size;
  }

  /**
   * Walk the graph from a seed node (Dijkstra by edge cost). Stale
   * (superseded) nodes are skipped. Returns hits ordered by cost.
   */
  walk(seedId: string, maxCost = 8, maxHits = 50): WalkHit[] {
    if (!this.nodes.has(seedId)) return [];
    const best = new Map<string, { cost: number; path: string }>([[seedId, { cost: 0, path: this.nodes.get(seedId)!.type }]]);
    const queue: Array<{ id: string; cost: number }> = [{ id: seedId, cost: 0 }];
    const relax = (fromId: string, toId: string, stepCost: number, step: string) => {
      const nextCost = best.get(fromId)!.cost + stepCost;
      if (nextCost > maxCost) return;
      const prev = best.get(toId);
      if (prev && prev.cost <= nextCost) return;
      best.set(toId, { cost: nextCost, path: `${best.get(fromId)!.path}${step}` });
      queue.push({ id: toId, cost: nextCost });
    };
    while (queue.length) {
      queue.sort((a, b) => a.cost - b.cost);
      const current = queue.shift()!;
      for (const edge of this.outEdges.get(current.id) ?? []) {
        relax(current.id, edge.to, edge.cost, ` -> ${edge.type} -> ${this.nodes.get(edge.to)!.type}`);
      }
      // Reverse traversal: task <- supports - evidence (context flows backwards).
      for (const edge of this.incomingOf(current.id)) {
        if (!REVERSE_TRAVERSABLE.has(edge.type)) continue;
        relax(current.id, edge.from, edge.cost + 1, ` <- ${edge.type} <- ${this.nodes.get(edge.from)!.type}`);
      }
    }
    const hits: WalkHit[] = [];
    for (const [id, info] of best) {
      if (id === seedId) continue;
      if (this.superseded.has(id)) continue;
      hits.push({ node: this.nodes.get(id)!, cost: info.cost, path: info.path });
    }
    return hits.sort((a, b) => a.cost - b.cost || a.node.createdAt.localeCompare(b.node.createdAt)).slice(0, maxHits);
  }

  /** Relevance of a hit: type weight decayed by path cost, boosted by recency. */
  scoreHit(hit: WalkHit, nowMs = Date.now()): number {
    const ageDays = Math.max(0, (nowMs - Date.parse(hit.node.createdAt)) / 86_400_000);
    const recency = 1 / (1 + ageDays / 30);
    return NODE_TYPE_WEIGHTS[hit.node.type] * Math.pow(0.75, hit.cost) * (0.5 + 0.5 * recency);
  }

  serialize(): string {
    return JSON.stringify({
      version: 1,
      nodes: [...this.nodes.values()],
      edges: [...this.outEdges.values()].flat()
    });
  }

  static deserialize(json: string): MemoryGraph {
    const data = JSON.parse(json) as { version: number; nodes: MemoryNode[]; edges: MemoryEdge[] };
    if (data.version !== 1) throw new Error(`unsupported memory graph version ${data.version}`);
    const graph = new MemoryGraph();
    for (const node of data.nodes) graph.nodes.set(node.id, node);
    for (const edge of data.edges) {
      const list = graph.outEdges.get(edge.from) ?? [];
      list.push(edge);
      graph.outEdges.set(edge.from, list);
      if (edge.type === "supersedes") graph.superseded.add(edge.to);
    }
    return graph;
  }
}

/**
 * Record a stage outcome into the graph: task -decided_by-> decision,
 * task -produces-> result, goal -decomposes-> task. Returns the new nodes.
 * This is the live-write path: every stage execution enriches the graph
 * instead of only emitting flat receipts.
 */
export function recordStageOutcome(
  graph: MemoryGraph,
  input: {
    goalId?: string;
    goalTitle: string;
    taskTitle: string;
    decisionSummary: string;
    resultSummary: string;
    metadata?: Record<string, unknown>;
  }
): { task: MemoryNode; decision: MemoryNode; result: MemoryNode } {
  let goal = input.goalId ? graph.getNode(input.goalId) : undefined;
  if (!goal) {
    goal = graph.addNode({ type: "goal", title: input.goalTitle, body: input.goalTitle, metadata: input.metadata });
  }
  const task = graph.addNode({ type: "task", title: input.taskTitle, body: input.taskTitle, metadata: input.metadata });
  const decision = graph.addNode({ type: "decision", title: `Routing: ${input.taskTitle}`, body: input.decisionSummary, metadata: input.metadata });
  const result = graph.addNode({ type: "result", title: `Result: ${input.taskTitle}`, body: input.resultSummary, metadata: input.metadata });
  graph.addEdge(goal.id, task.id, "decomposes");
  graph.addEdge(task.id, decision.id, "decided_by");
  graph.addEdge(task.id, result.id, "produces");
  return { task, decision, result };
}
