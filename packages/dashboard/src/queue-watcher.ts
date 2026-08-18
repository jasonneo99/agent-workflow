export function queueSnapshotSignature(queue: unknown): string {
  if (!Array.isArray(queue)) return "invalid";
  return JSON.stringify(queue.map((item) => {
    const row = item as Record<string, unknown>;
    return [row.runId, row.runStatus, row.completedTasks, row.queuedTasks, row.runningTasks, row.failedTasks, row.runningStageId, row.nextStageId];
  }));
}

export function queueWatcherScript(): string {
  return `
let timer;
let lastSignature = null;
let intervalMs = 2000;

function signature(queue) {
  if (!Array.isArray(queue)) return "invalid";
  return JSON.stringify(queue.map((item) => [item.runId, item.runStatus, item.completedTasks, item.queuedTasks, item.runningTasks, item.failedTasks, item.runningStageId, item.nextStageId]));
}

async function poll() {
  try {
    const response = await fetch("/api/queue", { cache: "no-store" });
    if (!response.ok) throw new Error("Queue request failed: " + response.status);
    const queue = await response.json();
    const nextSignature = signature(queue);
    const active = queue.filter((item) => item.runStatus === "queued" || item.runStatus === "running").length;
    const changed = lastSignature !== null && nextSignature !== lastSignature;
    lastSignature = nextSignature;
    intervalMs = active > 0 ? 2000 : 10000;
    self.postMessage({ type: "snapshot", changed, active, checkedAt: new Date().toISOString() });
  } catch (error) {
    intervalMs = Math.min(Math.max(intervalMs * 2, 5000), 30000);
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() });
  } finally {
    timer = setTimeout(poll, intervalMs);
  }
}

self.onmessage = (event) => {
  if (event.data?.type === "start") {
    lastSignature = event.data.signature ?? null;
    clearTimeout(timer);
    poll();
  }
  if (event.data?.type === "stop") clearTimeout(timer);
};
`;
}
