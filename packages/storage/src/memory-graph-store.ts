/**
 * Production persistence for the memory graph: memory_nodes / memory_edges
 * tables, keyed by project_id. The graph is small (hundreds of nodes per
 * project, not millions), so save/load move the whole project graph in one
 * transaction; walks run in memory via MemoryGraph.
 */
import { withClient } from "./client.js";
import { MemoryGraph, type MemoryEdge, type MemoryNode, type MemoryNodeType, type MemoryEdgeType } from "./memory-graph.js";

const NODE_TYPES: MemoryNodeType[] = ["goal", "task", "evidence", "artifact", "decision", "action", "result"];
const EDGE_TYPES: MemoryEdgeType[] = ["decomposes", "supports", "produces", "decided_by", "executes", "leads_to", "supersedes", "relates"];

function assertNodeType(value: string): MemoryNodeType {
  if ((NODE_TYPES as string[]).includes(value)) return value as MemoryNodeType;
  throw new Error(`unknown memory node type ${value}`);
}

function assertEdgeType(value: string): MemoryEdgeType {
  if ((EDGE_TYPES as string[]).includes(value)) return value as MemoryEdgeType;
  throw new Error(`unknown memory edge type ${value}`);
}

/** Persist a project's memory graph (upsert; safe to call after every stage). */
export async function saveMemoryGraph(projectId: string, graph: MemoryGraph): Promise<{ nodes: number; edges: number }> {
  const data = JSON.parse(graph.serialize()) as { nodes: MemoryNode[]; edges: MemoryEdge[] };
  return withClient(async (client) => {
    await client.query("begin");
    try {
      let nodes = 0;
      for (const node of data.nodes) {
        await client.query(
          `insert into memory_nodes (project_id, node_id, node_type, title, body, token_estimate, created_at, metadata)
           values ($1, $2, $3::text, $4, $5, $6::integer, $7::timestamptz, $8::jsonb)
           on conflict (project_id, node_id) do update set
             title = excluded.title, body = excluded.body, token_estimate = excluded.token_estimate,
             metadata = excluded.metadata`,
          [projectId, node.id, node.type, node.title, node.body, node.tokenEstimate, node.createdAt, JSON.stringify(node.metadata)]
        );
        nodes += 1;
      }
      let edges = 0;
      for (const edge of data.edges) {
        await client.query(
          `insert into memory_edges (project_id, from_node, to_node, edge_type, cost, created_at)
           values ($1, $2, $3, $4::text, $5::numeric, $6::timestamptz)
           on conflict (project_id, from_node, to_node, edge_type) do nothing`,
          [projectId, edge.from, edge.to, edge.type, edge.cost, edge.createdAt]
        );
        edges += 1;
      }
      await client.query("commit");
      return { nodes, edges };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

/** Load a project's memory graph. Returns an empty graph when none is stored. */
export async function loadMemoryGraph(projectId: string): Promise<MemoryGraph> {
  return withClient(async (client) => {
    const nodeRows = await client.query(
      `select node_id as "nodeId", node_type as "nodeType", title, body,
              token_estimate as "tokenEstimate", created_at as "createdAt", metadata
       from memory_nodes where project_id = $1 order by created_at`,
      [projectId]
    );
    const edgeRows = await client.query(
      `select from_node as "fromNode", to_node as "toNode", edge_type as "edgeType",
              cost, created_at as "createdAt"
       from memory_edges where project_id = $1 order by created_at`,
      [projectId]
    );
    const graph = new MemoryGraph();
    for (const row of nodeRows.rows) {
      const node: MemoryNode = {
        id: row.nodeId,
        type: assertNodeType(row.nodeType),
        title: row.title,
        body: row.body ?? "",
        tokenEstimate: Number(row.tokenEstimate) || 1,
        createdAt: new Date(row.createdAt).toISOString(),
        metadata: row.metadata ?? {}
      };
      // addNode regenerates ids; bypass via deserialize-shaped insert.
      (graph as unknown as { nodes: Map<string, MemoryNode> }).nodes.set(node.id, node);
    }
    for (const row of edgeRows.rows) {
      const edge: MemoryEdge = {
        from: row.fromNode,
        to: row.toNode,
        type: assertEdgeType(row.edgeType),
        cost: Number(row.cost),
        createdAt: new Date(row.createdAt).toISOString()
      };
      const out = (graph as unknown as { outEdges: Map<string, MemoryEdge[]> }).outEdges;
      const list = out.get(edge.from) ?? [];
      list.push(edge);
      out.set(edge.from, list);
      if (edge.type === "supersedes") {
        (graph as unknown as { superseded: Set<string> }).superseded.add(edge.to);
      }
    }
    return graph;
  });
}

/** Remove a project's memory graph (GDPR / reset path). */
export async function deleteMemoryGraph(projectId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("delete from memory_edges where project_id = $1", [projectId]);
    await client.query("delete from memory_nodes where project_id = $1", [projectId]);
  });
}

/** Idempotency check: has this task already been recorded for the project? */
export async function hasStageRecord(projectId: string, taskId: string): Promise<boolean> {
  return withClient(async (client) => {
    const rows = await client.query(
      `select 1 from memory_nodes
       where project_id = $1 and node_type = 'task' and metadata->>'taskId' = $2
       limit 1`,
      [projectId, taskId]
    );
    return rows.rows.length > 0;
  });
}
