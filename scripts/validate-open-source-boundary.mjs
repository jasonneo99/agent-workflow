import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { packageProvenanceViolations, scanBoundaryFile } from "./open-source-boundary-rules.mjs";

const root = process.cwd();
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations = [];

for (const file of trackedFiles) {
  if (["scripts/validate-open-source-boundary.mjs", "scripts/open-source-boundary-rules.mjs"].includes(file)) continue;
  if (!fs.existsSync(file)) continue;
  const buffer = fs.readFileSync(file);
  violations.push(...scanBoundaryFile(file, buffer));
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  console.error("Open-source boundary validation could not inspect the npm package payload.");
  process.exit(packed.status ?? 1);
}
let packageFiles;
try {
  packageFiles = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
} catch {
  console.error("Open-source boundary validation could not parse npm pack output.");
  process.exit(1);
}
violations.push(...packageProvenanceViolations(packageFiles, new Set(trackedFiles)));
for (const file of packageFiles) {
  if (!fs.existsSync(file) || ["scripts/validate-open-source-boundary.mjs", "scripts/open-source-boundary-rules.mjs"].includes(file)) continue;
  violations.push(...scanBoundaryFile(file, fs.readFileSync(file), { packageEntry: true }));
}

if (violations.length) {
  console.error("Open-source boundary validation failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("Generalize, scrub, or move this material to a private companion repository.");
  process.exit(1);
}

console.log(`Open-source boundary validated across ${trackedFiles.length} tracked files and ${packageFiles.length} package entries.`);
