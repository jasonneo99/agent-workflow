import { randomUUID } from "node:crypto";

/** Call once at worker startup, never per claim or heartbeat. */
export function createWorkerIdentity(label: string): { workerLabel: string; workerId: string } {
  const workerLabel = label.trim() || "worker";
  return { workerLabel, workerId: `${workerLabel}@${randomUUID()}` };
}
