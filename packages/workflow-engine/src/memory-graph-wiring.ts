/**
 * Production wiring between the workflow executor and the memory graph
 * (AIR phase 3). Two failure-safe entry points:
 *
 * - buildMemoryContextForStage: read path. Loads the project's graph, walks
 *   from the project goal node, and returns prompt-ready context lines.
 *   Never throws.
 * - recordStageMemoryGraph: write path. Records the stage outcome
 *   (goal/task/decision/result nodes) idempotently per taskId, linked under
 *   the run's goal, which itself hangs off the project goal. Never throws.
 *
 * The graph is scoped per project (projectRootUri), not per run: every run's
 * stages are visible to later runs of the same project. Both entry points are
 * disabled when AGENTFLOW_MEMORY_GRAPH=0. The memory graph must never break
 * stage execution: every failure degrades to "no memory".
 */
import { selectFromMemoryGraph } from "../../context-selector/src/index.js";
import { recordStageOutcome } from "../../storage/src/memory-graph.js";
import { hasStageRecord, loadMemoryGraph, saveMemoryGraph } from "../../storage/src/memory-graph-store.js";

/** Kill-switch for the whole memory-graph loop. Default on. */
export function isMemoryGraphEnabled(): boolean {
  return process.env.AGENTFLOW_MEMORY_GRAPH !== "0";
}

/** Deterministic node ids: re-recording a stage upserts the same rows. */
export function memoryNodeIds(taskId: string): { goal: string; task: string; decision: string; result: string } {
  return {
    goal: `goal:${taskId}`,
    task: `task:${taskId}`,
    decision: `decision:${taskId}`,
    result: `result:${taskId}`
  };
}

export interface StageOutcomeRecord {
  /** Project-level scope key (the executor passes the resolved projectRootUri). */
  projectId: string;
  /** Run scope: the goal node is shared per run, runs hang off the project goal. */
  runId: string;
  taskId: string;
  goalTitle: string;
  taskTitle: string;
  decisionSummary: string;
  resultSummary: string;
}

/** Pure: the project-level anchor node id. One per project, across runs. */
export function projectGoalId(projectId: string): string {
  return `project-goal:${projectId}`;
}

/**
 * Pure builder: the recordStageOutcome input for a completed stage.
 * The goal node is shared per run (goalId = run scope); the task node id
 * makes the write idempotent per taskId. Tested in isolation.
 */
export function buildStageOutcomeInput(record: StageOutcomeRecord): Parameters<typeof recordStageOutcome>[1] {
  const ids = memoryNodeIds(record.taskId);
  return {
    goalId: `run-goal:${record.runId}`,
    goalTitle: record.goalTitle,
    taskTitle: record.taskTitle,
    decisionSummary: record.decisionSummary,
    resultSummary: record.resultSummary,
    metadata: { taskId: record.taskId, runId: record.runId, projectId: record.projectId, source: "executor" },
    nodeIds: { task: ids.task, decision: ids.decision, result: ids.result }
  };
}

/** Pure: format graph selections into prompt-ready lines. Tested in isolation. */
export function formatMemoryContext(
  selections: Array<{ summary: string; sourceUri: string }>
): string[] {
  return selections.map((selection) => `- ${selection.summary} (${selection.sourceUri})`);
}

export interface MemoryContextRequest {
  projectId: string;
  stageGoal: string;
  taskLabel: string;
  maxTokens?: number;
}

/** Read path: relevant past context for the stage prompt. Never throws. */
export async function buildMemoryContextForStage(request: MemoryContextRequest): Promise<string[]> {
  try {
    if (!isMemoryGraphEnabled()) return [];
    const graph = await loadMemoryGraph(request.projectId);
    const goal = graph.getNode(projectGoalId(request.projectId));
    if (!goal) return [];
    const selections = selectFromMemoryGraph({
      graph,
      seedId: goal.id,
      task: `${request.stageGoal} ${request.taskLabel}`,
      maxTokens: request.maxTokens ?? 1500,
      maxNodes: 8
    });
    return formatMemoryContext(selections);
  } catch {
    return [];
  }
}

/** Write path: record a completed stage outcome. Idempotent, never throws. */
export async function recordStageMemoryGraph(record: StageOutcomeRecord): Promise<void> {
  try {
    if (!isMemoryGraphEnabled()) return;
    if (await hasStageRecord(record.projectId, record.taskId)) return;
    const graph = await loadMemoryGraph(record.projectId);
    recordStageOutcome(graph, buildStageOutcomeInput(record));
    // Project anchor: one goal per project; each run's goal decomposes from
    // it, so later runs walk into every earlier run's stages.
    const anchorId = projectGoalId(record.projectId);
    if (!graph.getNode(anchorId)) {
      graph.addNode({
        id: anchorId,
        type: "goal",
        title: "Project memory",
        body: `Cross-run memory anchor for ${record.projectId}`,
        metadata: { projectId: record.projectId, source: "executor" }
      });
    }
    graph.addEdge(anchorId, `run-goal:${record.runId}`, "decomposes");
    await saveMemoryGraph(record.projectId, graph);
  } catch {
    // The memory graph is advisory; stage completion already succeeded.
  }
}
