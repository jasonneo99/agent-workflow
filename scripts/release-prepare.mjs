#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSigningKey = path.join(os.homedir(), ".local", "share", "agent-workflow-release", "signing-ed25519-private.pem");
const defaultSigner = "jasonneo99-release";

const args = process.argv.slice(2);
const dryRun = takeFlag("--dry-run");
const allowDirty = takeFlag("--allow-dirty");
const skipTests = takeFlag("--skip-tests");
const signingKey = takeOption("--signing-key") ?? process.env.AGENTFLOW_RELEASE_SIGNING_KEY ?? defaultSigningKey;
const signer = takeOption("--signer") ?? process.env.AGENTFLOW_RELEASE_SIGNER ?? defaultSigner;
const bump = args.shift() ?? "patch";

if (args.length) {
  fail(`Unknown argument(s): ${args.join(" ")}`);
}

if (!["patch", "minor", "major"].includes(bump) && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bump)) {
  fail("Release bump must be patch, minor, major, or an explicit semver version.");
}

main();

function main() {
  process.chdir(rootDir);
  const currentVersion = readPackageVersion();

  console.log(`Agent Workflow release prepare`);
  console.log(`Current version: ${currentVersion}`);
  console.log(`Requested bump: ${bump}`);
  console.log(`Signer: ${signer}`);
  console.log(`Signing key: ${signingKey}`);

  if (!fs.existsSync(signingKey)) {
    fail(`Signing key was not found: ${signingKey}`);
  }

  const status = gitStatus();
  if (status && dryRun) {
    console.log("\nWorking tree has changes; real release prep will require a clean tree unless --allow-dirty is passed.");
  } else if (status && !allowDirty) {
    fail(`Working tree is not clean. Commit or stash changes first, or pass --allow-dirty.\n${status}`);
  }

  if (dryRun) {
    console.log("\nDry run only. No files were changed.");
    console.log("Would run:");
    printPlan();
    return;
  }

  run("npm", ["version", bump, "--no-git-tag-version"]);
  const nextVersion = readPackageVersion();
  run("npm", ["run", "bundle-manifest", "--", "--write"]);
  run("npm", ["run", "agentflow", "--", "bundle-sign", "--private-key", signingKey, "--signer", signer]);
  run("npm", ["run", "validate"]);
  run("npm", ["run", "validate-examples"]);
  run("npm", ["run", "typecheck"]);
  if (!skipTests) run("npm", ["test"]);
  run("npm", ["run", "pack:check"]);

  console.log("\nRelease preparation complete.");
  console.log(`Prepared version: ${nextVersion}`);
  console.log("\nNext commands:");
  console.log("git add package.json package-lock.json agent-workflow.bundle.json agent-workflow.bundle.sig.json");
  console.log(`git commit -m "Prepare v${nextVersion} package release"`);
  console.log("git push origin master");
  console.log("\nThen run the GitHub Actions workflow: Publish Package");
}

function printPlan() {
  console.log(`npm version ${bump} --no-git-tag-version`);
  console.log("npm run bundle-manifest -- --write");
  console.log(`npm run agentflow -- bundle-sign --private-key ${signingKey} --signer ${signer}`);
  console.log("npm run validate");
  console.log("npm run validate-examples");
  console.log("npm run typecheck");
  if (!skipTests) console.log("npm test");
  console.log("npm run pack:check");
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
}

function gitStatus() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) {
    fail(result.stderr || "Could not read git status.");
  }
  return result.stdout.trim();
}

function run(command, commandArgs) {
  console.log(`\n$ ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd: rootDir, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function takeFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
