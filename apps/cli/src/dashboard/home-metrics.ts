export function dashboardRunDurationMs(run: { startedAt: string; finishedAt?: string | null }): number | null {
  if (!run.finishedAt) return null;
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function formatDashboardDuration(durationMs: number | null): string {
  if (durationMs === null) return "n/a";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}
