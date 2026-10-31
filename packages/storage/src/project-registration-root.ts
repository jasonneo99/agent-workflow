import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Only a local Git common directory proves a worktree relationship. Never
 * match names, remotes, home-directory aliases, or missing filesystem roots.
 */
export async function projectRegistrationRoot(rootUri: string): Promise<{ rootUri:string; commonRoot?:string }> {
  if (!path.isAbsolute(rootUri)) throw new Error("Project registration requires an absolute top-level root.");
  let output:string;
  try {
    await fs.access(rootUri);
    output=(await exec("git",["-C",rootUri,"rev-parse","--path-format=absolute","--show-toplevel","--git-common-dir"],{timeout:2000,maxBuffer:8192})).stdout;
  } catch { return {rootUri}; } // Non-Git and unavailable remote roots remain independent.
  const [top,common] = output.trim().split("\n");
  if (!top || !common) throw new Error("Invalid Git project-root proof.");
  if (await fs.realpath(rootUri) !== await fs.realpath(top)) throw new Error("Register the top-level repository, not a subdirectory; use file scopes beneath the project.");
  const commonDirectory=await fs.realpath(common);
  return {rootUri,...(path.basename(commonDirectory)===".git" ? {commonRoot:path.dirname(commonDirectory)} : {})};
}
