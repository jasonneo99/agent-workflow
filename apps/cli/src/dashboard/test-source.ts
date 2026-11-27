import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

/** daemon.ts plus the dashboard modules split out of it (ui/, pages/, api/),
 * for tests that check dashboard source as text. Moving code between these
 * files keeps those tests pointed at it. */
export function dashboardSourcePaths(): string[] {
  const paths = [path.join(dashboardDir, "..", "commands", "daemon.ts")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) paths.push(full);
    }
  };
  for (const sub of ["ui", "pages", "api"]) if (existsSync(path.join(dashboardDir, sub))) walk(path.join(dashboardDir, sub));
  return paths;
}

export function dashboardSource(): string {
  return dashboardSourcePaths().map(file => readFileSync(file, "utf8")).join("\n");
}
