import { defaultDaemonTrustSettings, type DaemonTrustSettings } from "../../../../packages/daemon-control/src/index.js";
import { trustSettingsFromForm } from "../../../../packages/daemon-control/src/settings.js";

export function parseDaemonSettingsRequest(form: Pick<FormData, "get">) {
  return { daemonTrustLevels: trustSettingsFromForm(form) };
}

export type LearningSettingsSection = "daemon-trust" | "workflow-shape";

export function parseLearningSettingsSection(form: Pick<FormData, "get">): LearningSettingsSection | null {
  const value = form.get("settingsSection");
  return value === "daemon-trust" || value === "workflow-shape" ? value : null;
}

export function selectDaemonTrustSettings(
  section: LearningSettingsSection,
  form: Pick<FormData, "get">,
  existing?: DaemonTrustSettings
): DaemonTrustSettings {
  return section === "daemon-trust" ? trustSettingsFromForm(form) : existing ?? defaultDaemonTrustSettings();
}

export function selectLearningProjectRoot(input: {
  requested?: string | null;
  configured?: string | null;
  runtimeRoot: string;
  projects: Array<{ rootUri: string }>;
}): string {
  if (input.requested?.trim()) return input.requested;
  if (input.configured?.trim()) return input.configured;
  const runtimeRoot = input.runtimeRoot.replace(/[\\/]+$/u, "");
  const exactRuntime = input.projects.find((project) => project.rootUri.replace(/[\\/]+$/u, "") === runtimeRoot);
  if (exactRuntime) return exactRuntime.rootUri;
  const mutableProject = input.projects.find((project) => !/[\\/]releases[\\/]agent-workflow[\\/][^\\/]+(?:[\\/]|$)/u.test(project.rootUri));
  return mutableProject?.rootUri ?? input.projects[0]?.rootUri ?? "";
}
