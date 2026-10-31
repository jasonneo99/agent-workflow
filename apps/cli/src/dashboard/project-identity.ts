export interface ProjectIdentityInput {
  project: { name: string; rootUri: string; identityId?:string; identityRootUri?:string };
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
  return new Map(items.map((item) => {
    if (item.project.identityId && item.project.identityRootUri) return [item,item.project.identityRootUri];
    // Missing identity metadata is uncertainty, never permission to infer a merge.
    return [item,item.resolution.storageRootUri];
  }));
}

/** Stable registry presentation; never rewrite a checkout's execution scope. */
export function canonicalProjectRegistrations<T extends {id:string;identityId?:string;locationKind?:string}>(projects:T[]):T[] {
  return projects.filter(p=>(!p.identityId || p.identityId===p.id) && p.locationKind!=="vendor");
}
