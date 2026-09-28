import { resolveLocalProjectPath } from "../../../../packages/runtime-root/src/index.js";

export interface TrainingProjectChoice {
  name: string;
  rootUri: string;
}

function preference(rootUri: string): number {
  if (rootUri.includes("/Projects/") && !rootUri.includes("/.codex/worktrees/")) return 0;
  if (!rootUri.includes("/.codex/worktrees/")) return 1;
  return 2;
}

export async function resolveTrainingProjectChoices<T extends TrainingProjectChoice>(
  projects: T[],
  requested: string | undefined,
  fallback: string
): Promise<{ projects: T[]; selected: string }> {
  const resolved = await Promise.all(projects.map(async (project) => ({ project, resolution: await resolveLocalProjectPath(project.rootUri) })));
  const local = resolved.filter((item) => item.resolution.localPathExists).map((item) => ({
    project: { ...item.project, rootUri: item.resolution.localRootUri },
    localRootUri: item.resolution.localRootUri
  }));
  const unique = [...new Map(local.sort((left, right) => preference(left.localRootUri) - preference(right.localRootUri)).map((item) => [item.localRootUri, item.project])).values()];
  const requestedResolution = requested ? await resolveLocalProjectPath(requested) : null;
  if (requestedResolution?.localPathExists) return { projects: unique, selected: requestedResolution.localRootUri };
  const requestedName = projects.find((project) => project.rootUri === requested)?.name;
  const nameMatch = requestedName ? unique.find((project) => project.name === requestedName) : null;
  if (nameMatch) return { projects: unique, selected: nameMatch.rootUri };
  const fallbackResolution = await resolveLocalProjectPath(fallback);
  if (fallbackResolution.localPathExists) return { projects: unique, selected: fallbackResolution.localRootUri };
  return { projects: unique, selected: unique[0]?.rootUri ?? fallback };
}
