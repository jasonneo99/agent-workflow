import { trustSettingsFromForm } from "../../../../packages/daemon-control/src/settings.js";

export function parseDaemonSettingsRequest(form: Pick<FormData, "get">) {
  return { daemonTrustLevels: trustSettingsFromForm(form) };
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
