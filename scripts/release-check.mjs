#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipTests = takeFlag("--skip-tests");
const noFetch = takeFlag("--no-fetch");
const allowCurrentVersion = takeFlag("--allow-current-version");
const allowDirty = takeFlag("--allow-dirty");
const gateRun = takeOption("--gate-run");
const gateProject = takeOption("--gate-project");
const gateConfig = takeOption("--gate-config");
const baselineRun = takeOption("--baseline-run");

if (args.length) fail(`Unknown argument(s): ${args.join(" ")}`);

const failures = [];
const warnings = [];

main();

function main() {
  process.chdir(rootDir);
  const packageJson = readJson("package.json");
  const manifest = readJson("agent-workflow.bundle.json");
  const signature = readJson("agent-workflow.bundle.sig.json");
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;

  console.log("Agent Workflow release check");
  console.log(`Package: ${packageName}@${packageVersion}`);

  checkRepoState();
  checkTrustedPublisherWorkflow();
  checkBundleVersions(packageVersion, manifest, signature);
  checkPublishedVersion(packageName, packageVersion);
  checkPackageContents();
  checkNpmAuth();
  runCheck("Validate definitions", ["npm", ["run", "validate"]]);
  runCheck("Validate scrubbed examples", ["npm", ["run", "validate-examples"]]);
  runCheck("Typecheck", ["npm", ["run", "typecheck"]]);
  if (!skipTests) runCheck("Tests", ["npm", ["test"]]);
  runCheck("Package verification", ["npm", ["run", "pack:check"]]);
  checkEvaluationGate();

  console.log("\nRelease check summary");
  if (warnings.length) {
    console.log("\nWarnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
  if (failures.length) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`- ${failure}`);
    process.exit(1);
  }
  console.log("All release checks passed.");
}

function checkRepoState() {
  const status = run("git", ["status", "--porcelain"]);
  record(status.status === 0, "Git status", "Could not inspect git status.");
  if (status.status === 0) {
    const dirty = status.stdout.trim() !== "";
    if (dirty && allowDirty) {
      warnings.push("Working tree has uncommitted changes; allowed by --allow-dirty.");
      pass("Working tree dirty override");
    } else {
      record(!dirty, "Working tree clean", "Working tree has uncommitted changes.");
    }
  }

  const branch = run("git", ["branch", "--show-current"]);
  const branchName = branch.stdout.trim();
  record(branch.status === 0 && branchName.length > 0, "Current branch", "Could not determine the current branch.");

  if (!noFetch) {
    const fetch = run("git", ["fetch", "--quiet", "origin"]);
    record(fetch.status === 0, "Fetch origin", "Could not fetch origin for sync check.");
  }

  if (branchName) {
    const upstream = run("git", ["rev-parse", "--abbrev-ref", `${branchName}@{upstream}`]);
    if (upstream.status !== 0) {
      warnings.push(`Current branch ${branchName} has no upstream; skipping sync check.`);
    } else {
      const comparison = run("git", ["rev-list", "--left-right", "--count", `${branchName}...${upstream.stdout.trim()}`]);
      if (comparison.status === 0) {
        const [ahead, behind] = comparison.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        record(ahead === 0 && behind === 0, "Branch synced", `Current branch is ${ahead} commit(s) ahead and ${behind} commit(s) behind ${upstream.stdout.trim()}.`);
      } else {
        warnings.push("Could not compare current branch with upstream.");
      }
    }
  }
}

function checkTrustedPublisherWorkflow() {
  const workflowPath = path.join(rootDir, ".github", "workflows", "publish.yml");
  if (!fs.existsSync(workflowPath)) {
    failures.push("Trusted Publisher workflow is missing at .github/workflows/publish.yml.");
    return;
  }
  const text = fs.readFileSync(workflowPath, "utf8");
  record(/id-token:\s*write/.test(text), "OIDC permission", "publish.yml must grant id-token: write for npm Trusted Publishing.");
  record(/workflow_dispatch:/.test(text), "Manual publish trigger", "publish.yml should expose workflow_dispatch for explicit releases.");
  record(/npm publish --access public/.test(text), "npm publish step", "publish.yml must publish the public npm package.");
}

function checkBundleVersions(packageVersion, manifest, signature) {
  record(manifest.bundle?.version === packageVersion, "Manifest version", `Bundle manifest version ${manifest.bundle?.version ?? "missing"} does not match package version ${packageVersion}.`);
  record(signature.bundleVersion === packageVersion, "Signature version", `Bundle signature version ${signature.bundleVersion ?? "missing"} does not match package version ${packageVersion}.`);
  record(signature.manifestChecksum === manifest.checksum?.value, "Signature checksum", "Bundle signature checksum does not match the manifest checksum.");
  record(Boolean(signature.signer?.id && signature.signer?.keyFingerprint && signature.signature), "Signature metadata", "Bundle signature is missing signer metadata or signature bytes.");
}

function checkPublishedVersion(packageName, packageVersion) {
  const published = run("npm", ["view", packageName, "version"]);
  if (published.status !== 0) {
    warnings.push("Could not read the currently published npm version; network or registry auth may be unavailable.");
    return;
  }
  const publishedVersion = published.stdout.trim();
  const comparison = compareSemver(packageVersion, publishedVersion);
  if (comparison > 0) {
    pass(`Version ${packageVersion} is newer than published ${publishedVersion}`);
  } else if (comparison === 0 && allowCurrentVersion) {
    pass(`Version ${packageVersion} is already published; allowed by --allow-current-version`);
  } else {
    failures.push(`Package version ${packageVersion} must be greater than published version ${publishedVersion} before publishing.`);
  }
}

function checkPackageContents() {
  const packed = run("npm", ["pack", "--dry-run", "--json"]);
  if (packed.status !== 0) {
    failures.push("npm pack --dry-run failed.");
    return;
  }
  let files;
  try {
    files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
  } catch {
    failures.push("Could not parse npm pack --dry-run output.");
    return;
  }
  const required = [
    "README.md",
    "docs/README.md",
    "docs/user-guide.md",
    "docs/assets/screenshots/dashboard-home.png",
    "docs/assets/screenshots/dashboard-run-detail.png",
    "docs/assets/screenshots/dashboard-workflow-mind-map.png",
    "docs/assets/screenshots/dashboard-workflow-network.png"
  ];
  const missing = required.filter((file) => !files.has(file));
  record(missing.length === 0, "Package contents", `Package is missing expected release/docs files: ${missing.join(", ")}`);
}

function checkNpmAuth() {
  const whoami = run("npm", ["whoami"]);
  if (whoami.status === 0) {
    pass(`Local npm auth available as ${whoami.stdout.trim()}`);
  } else {
    warnings.push("Local npm auth is unavailable. This is OK for Trusted Publishing; GitHub Actions publishes through OIDC.");
  }
}

function checkEvaluationGate() {
  if (!gateRun) {
    warnings.push("No evaluation gate run supplied; skipping release gate. Use --gate-run <id> to enforce project-local quality/cost budgets.");
    return;
  }
  const commandArgs = ["run", "agentflow", "--", "gate", "--run", gateRun];
  if (gateProject) commandArgs.push("--project", gateProject);
  if (gateConfig) commandArgs.push("--gate", gateConfig);
  if (baselineRun) commandArgs.push("--baseline-run", baselineRun);
  runCheck("Evaluation gate", ["npm", commandArgs]);
}

function runCheck(label, [command, commandArgs]) {
  const result = spawnSync(command, commandArgs, { cwd: rootDir, stdio: "inherit" });
  record(result.status === 0, label, `${label} failed.`);
}

function record(ok, label, failure) {
  if (ok) pass(label);
  else failures.push(failure);
}

function pass(label) {
  console.log(`OK: ${label}`);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, { cwd: rootDir, encoding: "utf8" });
}

function compareSemver(left, right) {
  const parse = (value) => value.split(/[+-]/)[0].split(".").map((part) => Number.parseInt(part, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function takeFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
