export type ThroughputBucket = {
  key: string;
  label: string;
  completed: number;
  failed: number;
  active: number;
};

type ThroughputRun = { startedAt: string; status: string };

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function buildWeeklyThroughputBuckets(runs: ThroughputRun[], now = new Date()): ThroughputBucket[] {
  const buckets: ThroughputBucket[] = [];
  const byDay = new Map<string, ThroughputBucket>();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    const bucket = {
      key: localDateKey(date),
      label: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      completed: 0,
      failed: 0,
      active: 0
    };
    buckets.push(bucket);
    byDay.set(bucket.key, bucket);
  }
  for (const run of runs) {
    const date = new Date(run.startedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const bucket = byDay.get(localDateKey(date));
    if (!bucket) continue;
    if (run.status === "completed") bucket.completed += 1;
    else if (run.status === "failed") bucket.failed += 1;
    else bucket.active += 1;
  }
  return buckets;
}
