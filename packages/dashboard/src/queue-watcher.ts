export function queueSnapshotSignature(queue: unknown): string {
  if (!Array.isArray(queue)) return "invalid";
  return JSON.stringify(queue.filter(item=>item&&typeof item==="object").map((item) => {
    const row = item as Record<string, unknown>;
    const attempts=Array.isArray(row.familyAttempts)?row.familyAttempts.map((attempt)=>[
      attempt.id,attempt.status,attempt.blocker,
      (Array.isArray(attempt.approvals)?attempt.approvals:[]).map((approval:Record<string,unknown>)=>[approval.id,approval.status]).sort((a:unknown[],b:unknown[])=>String(a[0]).localeCompare(String(b[0])))
    ]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))):[];
    return [row.runId, row.runStatus, row.completedTasks, row.queuedTasks, row.runningTasks, row.failedTasks, row.runningStageId, row.nextStageId,
      row.blockedReason,row.failedReason,row.relatedOpenRunCount,row.versionSetId,attempts];
  }).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
}

export function queueWatcherScript(): string {
  return `
let timer;
let lastSignature = null;
let intervalMs = 2000;
let queueUrl = "/api/queue", stopped = true, generation = 0, request = null;
const signature = (${queueSnapshotSignature.toString()});

async function poll() {
  if (stopped || request) return;
  const current = generation, controller = new AbortController(); request = controller;
  const deadline = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(queueUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Queue request failed: " + response.status);
    const queue = await response.json();
    if (stopped || current !== generation) return;
    if (!Array.isArray(queue) || queue.length > 1000) throw new Error("Bounded queue response required");
    const nextSignature = signature(queue);
    const active = queue.filter((item) => ["queued", "leased", "running"].includes(item.runStatus)).length;
    const changed = lastSignature !== null && nextSignature !== lastSignature;
    lastSignature = nextSignature;
    intervalMs = active > 0 ? 2000 : 10000;
    self.postMessage({ type: "snapshot", changed, active, activities: queue.slice(0,100).map(item=>({runId:item.runId,liveActivity:item.liveActivity})), checkedAt: new Date().toISOString() });
  } catch (error) {
    if (stopped || current !== generation) return;
    intervalMs = Math.min(Math.max(intervalMs * 2, 5000), 30000);
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() });
  } finally {
    clearTimeout(deadline);
    if (current === generation) { request = null; if (!stopped) timer = setTimeout(poll, intervalMs); }
  }
}

self.onmessage = (event) => {
  if (event.data?.type === "start") {
    stopped = true; generation++; request?.abort(); request = null;
    const project = event.data.project;
    if (project !== null && project !== undefined && (typeof project !== "string" || project.length > 4096 || /[\\u0000-\\u001f]/u.test(project))) {
      self.postMessage({ type: "error", message: "Invalid exact project scope" }); return;
    }
    queueUrl = "/api/queue" + (project ? "?project=" + encodeURIComponent(project) : "");
    lastSignature = event.data.signature ?? null;
    clearTimeout(timer);
    stopped = false;
    poll();
  }
  if (event.data?.type === "stop") { stopped = true; generation++; clearTimeout(timer); request?.abort(); request = null; }
};
`;
}
