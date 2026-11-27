import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

/** daemon.ts plus the dashboard modules split out of it (ui/, data/, pages/, api/),
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
  for (const sub of ["ui", "data", "pages", "api"]) if (existsSync(path.join(dashboardDir, sub))) walk(path.join(dashboardDir, sub));
  return paths;
}

export function dashboardSource(): string {
  return dashboardSourcePaths().map(file => readFileSync(file, "utf8")).join("\n");
}

/** The text of one named function (`function name(` through its closing
 * brace) from the dashboard source, wherever it lives. */
export function functionSource(name: string, source = dashboardSource()): string {
  const match = new RegExp(`(?:async\\s+)?function ${name}\\b`, "u").exec(source);
  if (!match) throw new Error(`function ${name} not found in dashboard source`);
  // Skip the parameter list by paren depth (parameter types can span lines
  // and contain braces), then take the first brace that ends a line.
  let paren = 0, index = source.indexOf("(", match.index);
  for (; index < source.length; index += 1) {
    if (source[index] === "(") paren += 1;
    else if (source[index] === ")" && --paren === 0) break;
  }
  const start = source.indexOf("{\n", index);
  let depth = 0;
  for (let at = start; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    else if (source[at] === "}" && --depth === 0) return source.slice(match.index, at + 1);
  }
  return source.slice(match.index);
}
