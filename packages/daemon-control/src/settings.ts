import { daemonLanes, normalizeDaemonTrustSettings, type DaemonTrustLevel, type DaemonTrustSettings } from "./index.js";

export function trustSettingsFromForm(form: Pick<FormData, "get">): DaemonTrustSettings {
  return normalizeDaemonTrustSettings(Object.fromEntries(daemonLanes.map((lane) => [lane.id, form.get(`daemonTrust.${lane.id}`)])));
}

export function lowerTrustLevel(left: DaemonTrustLevel, right: DaemonTrustLevel): DaemonTrustLevel {
  const levels: DaemonTrustLevel[] = ["low", "medium", "high"];
  return levels[Math.min(levels.indexOf(left), levels.indexOf(right))] ?? "low";
}
