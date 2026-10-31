import type { ServerResponse } from "node:http";

export function workflowDisplayName(workflowId: string | null | undefined): string {
  if (!workflowId?.trim()) return "Unspecified workflow";
  if (workflowId === "debug-failure") return "Diagnose & Fix";
  if (workflowId === "investigate-issue") return "Investigate Issue";
  return workflowId.split("-").map((word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : word).join(" ");
}

/** Never append an error page to an already-started response. */
export function finishDashboardError(response: ServerResponse, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}
