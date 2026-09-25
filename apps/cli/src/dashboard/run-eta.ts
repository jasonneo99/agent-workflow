export type RunEta = {
  state: "estimated" | "learning" | "paused" | "complete";
  estimatedCompletionAt: string | null;
  remainingMs: number | null;
  projectedTotalMs: number | null;
  confidence: "none" | "low" | "medium" | "high";
  source: "historical-workflow" | "current-run-pace" | "none";
  sampleCount: number;
  completedTasks: number;
  totalTasks: number;
  reason: string;
};

export type AggregateRunEta = RunEta & {
  runs: Array<{ runId: string; eta: RunEta }>;
};

type EtaRun = {
  id: string;
  workflowId: string;
  projectRootUri: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
};

type EtaTask = { status: string; skipped?: boolean };

const MAX_HISTORY_SAMPLES = 20;
const MAX_VALID_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export function estimateRunEta(input: {
  run: EtaRun;
  tasks: EtaTask[];
  historicalRuns: EtaRun[];
  now?: number;
}): RunEta {
  const now = input.now ?? Date.now();
  const totalTasks = input.tasks.length;
  const completedTasks = input.tasks.filter((task) => task.status === "completed" || task.skipped === true).length;
  const active = ["queued", "leased", "running"].includes(input.run.status);
  if (!active) {
    const complete = input.run.status === "completed";
    return baseEta({ state: complete ? "complete" : "paused", totalTasks, completedTasks, reason: complete ? "Run is complete." : `ETA paused while the run is ${input.run.status}.` });
  }

  const startedAt = Date.parse(input.run.startedAt);
  if (!Number.isFinite(startedAt) || totalTasks === 0) {
    return baseEta({ state: "learning", totalTasks, completedTasks, reason: "Waiting for valid run timing and stage data." });
  }
  const elapsedMs = Math.max(0, now - startedAt);
  const projectSamples = historicalDurations(input.historicalRuns, input.run, true);
  const samples = projectSamples.length ? projectSamples : historicalDurations(input.historicalRuns, input.run, false);

  if (samples.length) {
    const baselineMs = median(samples);
    const progress = completedTasks / totalTasks;
    let projectedTotalMs = baselineMs;
    if (completedTasks > 0 && elapsedMs > 0) {
      const paceProjection = elapsedMs / Math.max(progress, 1 / totalTasks);
      const paceWeight = Math.min(0.5, progress);
      projectedTotalMs = Math.round(baselineMs * (1 - paceWeight) + paceProjection * paceWeight);
    }
    let remainingMs = Math.round(projectedTotalMs - elapsedMs);
    if (remainingMs <= 0 && completedTasks < totalTasks) {
      remainingMs = Math.max(1_000, Math.round((baselineMs / totalTasks) * (totalTasks - completedTasks)));
      projectedTotalMs = elapsedMs + remainingMs;
    }
    const confidence = samples.length >= 10 ? "high" : samples.length >= 3 ? "medium" : "low";
    return {
      state: "estimated",
      estimatedCompletionAt: new Date(now + Math.max(0, remainingMs)).toISOString(),
      remainingMs: Math.max(0, remainingMs),
      projectedTotalMs,
      confidence,
      source: "historical-workflow",
      sampleCount: samples.length,
      completedTasks,
      totalTasks,
      reason: `${projectSamples.length
        ? `Based on ${samples.length} completed run${samples.length === 1 ? "" : "s"} for this workflow and project`
        : `Based on ${samples.length} completed run${samples.length === 1 ? "" : "s"} for this workflow across projects`}${completedTasks > 0 ? ", adjusted by current progress" : ""}.`
    };
  }

  if (completedTasks > 0 && elapsedMs > 0 && completedTasks < totalTasks) {
    const remainingMs = Math.round((elapsedMs / completedTasks) * (totalTasks - completedTasks));
    return {
      state: "estimated",
      estimatedCompletionAt: new Date(now + remainingMs).toISOString(),
      remainingMs,
      projectedTotalMs: elapsedMs + remainingMs,
      confidence: "low",
      source: "current-run-pace",
      sampleCount: 0,
      completedTasks,
      totalTasks,
      reason: "No comparable completed runs were found; estimate uses this run's completed-stage pace."
    };
  }

  return baseEta({ state: "learning", totalTasks, completedTasks, reason: "ETA will appear after one stage completes or comparable workflow history is available." });
}

export function aggregateRunEtas(items: Array<{ runId: string; eta: RunEta }>, now = Date.now()): AggregateRunEta {
  const runs = items.map((item) => ({ runId: item.runId, eta: item.eta }));
  if (!items.length) return { ...baseEta({ state: "learning", totalTasks: 0, completedTasks: 0, reason: "No workflow runs are available to estimate." }), runs };
  const totalTasks = items.reduce((sum, item) => sum + item.eta.totalTasks, 0);
  const completedTasks = items.reduce((sum, item) => sum + item.eta.completedTasks, 0);
  if (items.every((item) => item.eta.state === "complete")) {
    return { ...baseEta({ state: "complete", totalTasks, completedTasks, reason: "All workflow runs are complete." }), runs };
  }
  const paused = items.find((item) => item.eta.state === "paused");
  if (paused) {
    return { ...baseEta({ state: "paused", totalTasks, completedTasks, reason: `Aggregate ETA paused because run ${paused.runId} is paused.` }), runs };
  }
  const estimates = items.filter((item) => item.eta.state === "estimated" && item.eta.estimatedCompletionAt && item.eta.remainingMs !== null);
  if (estimates.length !== items.length) {
    return { ...baseEta({ state: "learning", totalTasks, completedTasks, reason: "Aggregate ETA is waiting for evidence from every active workflow run." }), runs };
  }
  const slowest = estimates.reduce((latest, item) => Date.parse(item.eta.estimatedCompletionAt!) > Date.parse(latest.eta.estimatedCompletionAt!) ? item : latest);
  const confidenceOrder = { none: 0, low: 1, medium: 2, high: 3 } as const;
  const confidence = estimates.reduce<RunEta["confidence"]>((lowest, item) => confidenceOrder[item.eta.confidence] < confidenceOrder[lowest] ? item.eta.confidence : lowest, "high");
  const estimatedCompletionAt = slowest.eta.estimatedCompletionAt!;
  const remainingMs = Math.max(0, Date.parse(estimatedCompletionAt) - now);
  return {
    state: "estimated",
    estimatedCompletionAt,
    remainingMs,
    projectedTotalMs: null,
    confidence,
    source: estimates.every((item) => item.eta.source === "historical-workflow") ? "historical-workflow" : "current-run-pace",
    sampleCount: estimates.reduce((sum, item) => sum + item.eta.sampleCount, 0),
    completedTasks,
    totalTasks,
    reason: `Aggregate estimate follows the latest completion across ${items.length} workflow run${items.length === 1 ? "" : "s"}.`,
    runs
  };
}

function historicalDurations(runs: EtaRun[], current: EtaRun, sameProject: boolean): number[] {
  return runs
    .filter((run) => run.id !== current.id && run.status === "completed" && run.workflowId === current.workflowId)
    .filter((run) => !sameProject || run.projectRootUri === current.projectRootUri)
    .map((run) => Date.parse(run.finishedAt ?? "") - Date.parse(run.startedAt))
    .filter((duration) => Number.isFinite(duration) && duration > 0 && duration <= MAX_VALID_DURATION_MS)
    .slice(0, MAX_HISTORY_SAMPLES)
    .sort((left, right) => left - right);
}

function median(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle] ?? 0;
  return Math.round(((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2);
}

function baseEta(input: Pick<RunEta, "state" | "totalTasks" | "completedTasks" | "reason">): RunEta {
  return { ...input, estimatedCompletionAt: null, remainingMs: null, projectedTotalMs: null, confidence: "none", source: "none", sampleCount: 0 };
}
