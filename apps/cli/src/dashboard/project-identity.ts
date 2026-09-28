export interface ProjectIdentityInput {
  project: { name: string; rootUri: string };
  resolution: { storageRootUri: string; localRootUri: string; localPathExists: boolean };
}

const releaseRootPattern = /[/\\]releases[/\\][^/\\]+[/\\][0-9a-f]{7,64}$/u;

export function logicalProjectIdentityKeys(items: ProjectIdentityInput[]): Map<ProjectIdentityInput, string> {
  const mutableRootsByName = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.resolution.localPathExists || releaseRootPattern.test(item.resolution.localRootUri)) continue;
    const roots = mutableRootsByName.get(item.project.name) ?? new Set<string>();
    roots.add(item.resolution.localRootUri);
    mutableRootsByName.set(item.project.name, roots);
  }
  return new Map(items.map((item) => {
    const mutableRoots = mutableRootsByName.get(item.project.name);
    const releaseAlias = releaseRootPattern.test(item.resolution.storageRootUri) && mutableRoots?.size === 1;
    return [item, releaseAlias ? [...mutableRoots][0] : item.resolution.localPathExists ? item.resolution.localRootUri : item.resolution.storageRootUri];
  }));
}
