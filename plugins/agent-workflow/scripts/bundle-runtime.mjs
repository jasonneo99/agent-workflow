#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const runtimeRoot = path.join(pluginRoot, "runtime");
const runtimeArchive = path.join(pluginRoot, "runtime-bundle.tgz");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-plugin-runtime-"));

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
}

try {
  const runtimePin = JSON.parse(fs.readFileSync(path.join(pluginRoot, "runtime-version.json"), "utf8"));
  const packageSpec = `${runtimePin.package}@${runtimePin.version}`;
  const packResult = JSON.parse(execFileSync("npm", [
    "pack", packageSpec,
    "--ignore-scripts",
    "--pack-destination", temporaryRoot,
    "--json"
  ], { cwd: repositoryRoot, encoding: "utf8" }))[0];
  const archive = packResult?.filename;
  if (!archive) throw new Error(`npm pack did not produce an archive for ${packageSpec}`);

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  run("npm", [
    "install",
    "--prefix", runtimeRoot,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(temporaryRoot, archive)
  ]);
  fs.rmSync(path.join(runtimeRoot, "node_modules", ".bin"), { recursive: true, force: true });
  fs.writeFileSync(path.join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify({
    package: runtimePin.package,
    version: runtimePin.version,
    integrity: packResult.integrity,
    shasum: packResult.shasum,
    entrypoint: "node_modules/@jasonneo99/agent-workflow/dist/apps/mcp/src/index.js",
    builtAt: new Date().toISOString()
  }, null, 2)}\n`);
  execFileSync("tar", ["-czf", runtimeArchive, "-C", runtimeRoot, "."], { stdio: "inherit" });
  const archiveHash = execFileSync("shasum", ["-a", "256", runtimeArchive], { encoding: "utf8" }).trim().split(/\s+/)[0];
  fs.writeFileSync(`${runtimeArchive}.sha256`, `${archiveHash}  runtime-bundle.tgz\n`);
  console.log(`Bundled published ${packageSpec} into ${runtimeRoot}`);
  console.log(`Wrote ${runtimeArchive} (${archiveHash})`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
