import fs from "node:fs/promises";
import path from "node:path";

export async function boundedProjectFileSearch(projectRootUri: string, query: string): Promise<string[]> {
  return (await boundedProjectFileSearchResult(projectRootUri, query)).matches;
}

export async function boundedProjectFileSearchResult(projectRootUri: string, query: string): Promise<{ matches: string[]; truncated: boolean; inspected: number }> {
  const terms = query.toLowerCase().split(/[^a-z0-9._-]+/u).filter((term) => term.length >= 2).slice(0, 6);
  if (!terms.length) return { matches: [], truncated: false, inspected: 0 };
  const matches: string[] = [];
  let inspected = 0;
  let truncated = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || inspected >= 2500 || matches.length >= 40) { truncated = true; return; }
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    // Runtime receipts must not consume the source-discovery budget before source.
    entries.sort((a, b) => Number(a.name === ".agent-workflow") - Number(b.name === ".agent-workflow") || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (inspected >= 2500 || matches.length >= 40) { truncated = true; break; }
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "DerivedData" || entry.name === "build" || entry.name === "dist" || entry.name === "coverage") continue;
      if (entry.name.startsWith(".") && entry.name !== ".agent-workflow") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(projectRootUri, absolute).replace(/\\/g, "/");
      inspected += 1;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (/\.(?:env|pem|key|p12|mobileprovision)$/iu.test(entry.name)) continue;
      const haystack = relative.toLowerCase();
      if (terms.every((term) => haystack.includes(term))) matches.push(relative);
    }
  };
  await walk(projectRootUri, 0);
  return { matches: matches.sort((left, right) => left.length - right.length || left.localeCompare(right)), truncated, inspected };
}
