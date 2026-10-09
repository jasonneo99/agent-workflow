export interface ProjectIdentityInput {
  project: { name: string; rootUri: string };
  resolution: { storageRootUri: string; localRootUri: string; localPathExists: boolean };
}

const releaseRootPattern = /[/\\]releases[/\\][^/\\]+[/\\][0-9a-f]{7,64}$/u;
const worktreeRootPattern = /[/\\]\.codex[/\\]worktrees[/\\][^/\\]+(?:[/\\]|$)/u;
const temporaryRootPattern = /^(?:\/private)?\/tmp(?:\/|$)|^\/var\/folders(?:\/|$)/u;
const supportingRootPattern = /[/\\](?:fixtures?|templates?|vendor)[/\\]/u;

export type ProjectIdentityVisibility = "canonical" | "supporting";

export function projectIdentityVisibility(rootUri: string, localPathExists: boolean): ProjectIdentityVisibility {
  if (!localPathExists) return "supporting";
  if (releaseRootPattern.test(rootUri) || worktreeRootPattern.test(rootUri) || temporaryRootPattern.test(rootUri) || supportingRootPattern.test(rootUri)) {
    return "supporting";
  }
  return "canonical";
}

export function logicalProjectIdentityKeys(items: ProjectIdentityInput[]): Map<ProjectIdentityInput, string> {
  const mutableRootsByName = new Map<string, Set<string>>();
  for (const item of items) {
    if (projectIdentityVisibility(item.resolution.localRootUri, item.resolution.localPathExists) !== "canonical") continue;
    const roots = mutableRootsByName.get(item.project.name) ?? new Set<string>();
    roots.add(item.resolution.localRootUri);
    mutableRootsByName.set(item.project.name, roots);
  }
  return new Map(items.map((item) => {
    const mutableRoots = mutableRootsByName.get(item.project.name);
    const supportingAlias = projectIdentityVisibility(item.resolution.storageRootUri, item.resolution.localPathExists) === "supporting" && mutableRoots?.size === 1;
    return [item, supportingAlias ? [...mutableRoots][0] : item.resolution.localPathExists ? item.resolution.localRootUri : item.resolution.storageRootUri];
  }));
}
