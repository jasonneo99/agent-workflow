import fs from "node:fs/promises";
import path from "node:path";

/** Authoring may declare a new behavioral test before creating its file.
 * Automatic checks wait for those inputs; explicit baseline requests and
 * independent verifiers still execute normally and retain missing-file failures.
 * Returns the commands that name a project-local test file that does not exist yet. */
export async function missingAuthorTestCommands(commands: readonly string[], projectRoot: string): Promise<Set<string>> {
  const missing = new Set<string>();
  for (const command of commands) {
    const words = Array.from(command.matchAll(/"([^" ]+)"|'([^' ]+)'|[^\s]+/gu), match => match[1] ?? match[2] ?? match[0]);
    for (const word of words) {
      if (!/(?:^|\/)(?:test_[^/]+|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/u.test(word)) continue;
      const absolute = path.resolve(projectRoot, word);
      if (!absolute.startsWith(path.resolve(projectRoot) + path.sep)) continue;
      try { await fs.stat(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.add(command);
        else throw error;
      }
    }
  }
  return missing;
}
