#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}
const result = JSON.parse(packed.stdout)[0];
const files = new Set(result.files.map((file) => file.path));
const required = [
  "dist/apps/cli/src/index.js",
  "dist/apps/mcp/src/index.js",
  "dist/apps/cli/src/setup.js",
  "agents/core/workflow-orchestrator.yaml",
  "workflows/build-feature.yaml",
  "templates/project/AGENTS.md",
  "agent-workflow.bundle.json",
  "README.md",
  "LICENSE"
];
const missing = required.filter((file) => !files.has(file));
if (missing.length) {
  console.error(`Package is missing required files: ${missing.join(", ")}`);
  process.exit(1);
}
const smoke = spawnSync(process.execPath, ["dist/apps/cli/src/index.js", "list"], { encoding: "utf8" });
if (smoke.status !== 0 || !/workflow-orchestrator/.test(smoke.stdout) || !/build-feature/.test(smoke.stdout)) {
  process.stderr.write(smoke.stderr);
  console.error("Compiled CLI package smoke test failed.");
  process.exit(1);
}
console.log(`Package ready: ${result.name}@${result.version}, ${result.files.length} files, ${result.size} bytes packed.`);
