#!/usr/bin/env node
// Run the CLI from the compiled dist/ build when it is newer than every
// source file, and through tsx otherwise. Both paths run the same code; dist
// only skips about two seconds of on-the-fly TypeScript compilation. Set
// AGENTFLOW_LAUNCH=tsx to always use the sources.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_DIRS = ["apps", "packages"];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Newest source mtime under the given directories, in milliseconds. */
export function newestSourceMtime(rootDir, dirs = SOURCE_DIRS) {
  let newest = 0;
  const pending = dirs.map(dir => path.join(rootDir, dir));
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) pending.push(path.join(dir, entry.name)); continue; }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  }
  return newest;
}

/** The entry to run: the dist build only when it exists and no source is newer. */
export function selectLaunchEntry(rootDir, env = process.env) {
  const source = path.join(rootDir, "apps/cli/src/index.ts");
  const compiled = path.join(rootDir, "dist/apps/cli/src/index.js");
  if (env.AGENTFLOW_LAUNCH === "tsx") return { mode: "tsx", entry: source };
  let builtAt;
  try { builtAt = fs.statSync(compiled).mtimeMs; } catch { return { mode: "tsx", entry: source }; }
  return newestSourceMtime(rootDir) > builtAt ? { mode: "tsx", entry: source } : { mode: "dist", entry: compiled };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { mode, entry } = selectLaunchEntry(rootDir);
  if (mode === "tsx") {
    const { register } = await import("tsx/esm/api");
    register();
  }
  // The CLI parses argv only when it is the entry point, so present it as one.
  process.argv[1] = entry;
  await import(pathToFileURL(entry).href);
}
