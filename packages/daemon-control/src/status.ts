import { daemonLanes, normalizeDaemonTrustSettings, type DaemonTrustSettings } from "./index.js";

export type DaemonControlStatus = {
  kind: "agentflow_daemon_control_status";
  generatedAt: string;
  supervisor: "shared";
  lanes: Array<{ id: string; name: string; trust: string; mutationClass: string; status: "configured" }>;
};

export function buildDaemonControlStatus(settings: DaemonTrustSettings | unknown): DaemonControlStatus {
  const trust = normalizeDaemonTrustSettings(settings);
  return {
    kind: "agentflow_daemon_control_status",
    generatedAt: new Date().toISOString(),
    supervisor: "shared",
    lanes: daemonLanes.map((lane) => ({ id: lane.id, name: lane.name, trust: trust[lane.id], mutationClass: lane.mutationClass, status: "configured" }))
  };
}
