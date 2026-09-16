#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const value = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const required = (name) => { const result = value(name); if (!result) throw new Error(`--${name} is required`); return path.resolve(result); };
const releaseDir = required("release-dir");
const currentLink = required("current-link");
const healthUrl = value("health-url");
const restartCommand = value("restart-command");
const prepareCommand = value("prepare-command") ?? "npm ci && npm run build";
const timeoutMs = Math.max(1_000, Number(value("timeout-ms") ?? 60_000));
const prior = fs.existsSync(currentLink) ? await fsp.realpath(currentLink) : null;
const startedAt = Date.now();
const packageMetadata = JSON.parse(await fsp.readFile(new URL("../package.json", import.meta.url), "utf8"));
const bundleMetadata = JSON.parse(await fsp.readFile(new URL("../agent-workflow.bundle.json", import.meta.url), "utf8"));
const receipt = { kind: "agentflow_atomic_release", startedAt: new Date().toISOString(), releaseHash: createHash("sha256").update(releaseDir).digest("hex"), priorHash: prior ? createHash("sha256").update(prior).digest("hex") : null, phase: "prepared", rolledBack: false, rollbackHealthPassed: null, healthPassed: null, reusedPromotion: false, runtimeVersion: packageMetadata.version, bundleVersion: bundleMetadata.bundle?.version ?? "unknown", protocolVersions: { runtime: 1, storage: 1, bundle: 1 }, error: null };
const receiptDirectory = path.join(os.homedir(), ".local", "state", "agent-workflow", "releases");

function run(command, cwd = releaseDir) {
  const result = spawnSync("/bin/sh", ["-lc", command], { cwd, stdio: "inherit", timeout: timeoutMs, env: process.env });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Command failed (${result.status}): ${command}`);
}
async function switchLink(target) {
  const temporary = `${currentLink}.next-${process.pid}`;
  await fsp.symlink(target, temporary);
  await fsp.rename(temporary, currentLink);
}
async function health() {
  if (!healthUrl) return true;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch(healthUrl, { signal: controller.signal, headers: process.env.AGENTFLOW_SERVER_TOKEN ? { authorization: `Bearer ${process.env.AGENTFLOW_SERVER_TOKEN}` } : {} }); if (!response.ok) throw new Error(`Health check returned ${response.status}`); }
  finally { clearTimeout(timer); }
  return true;
}
async function writeReceipt() {
  await fsp.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(receiptDirectory, `${Date.now()}-${receipt.releaseHash.slice(0, 12)}.json`), `${JSON.stringify({ ...receipt, durationMs: Date.now() - startedAt }, null, 2)}\n`, { mode: 0o600 });
}

let resultMessage = null;
let operationError = null;
try {
  await fsp.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const priorReceipts = await fsp.readdir(receiptDirectory);
  for (const filename of priorReceipts.filter((entry) => entry.endsWith(`-${receipt.releaseHash.slice(0, 12)}.json`))) {
    const recorded = JSON.parse(await fsp.readFile(path.join(receiptDirectory, filename), "utf8"));
    if (recorded.releaseHash === receipt.releaseHash && recorded.phase === "promoted" && fs.existsSync(currentLink) && await fsp.realpath(currentLink) === releaseDir) {
      receipt.phase = "promoted"; receipt.reusedPromotion = true; receipt.healthPassed = await health();
      resultMessage = `Release already promoted: ${receipt.releaseHash.slice(0, 12)}`;
      break;
    }
  }
  if (!resultMessage) {
    run(prepareCommand); receipt.phase = "started";
    await switchLink(releaseDir);
    if (restartCommand) run(restartCommand, releaseDir);
    receipt.healthPassed = await health(); receipt.phase = "promoted";
    resultMessage = `Release promoted: ${receipt.releaseHash.slice(0, 12)}`;
  }
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  if (prior && fs.existsSync(prior)) {
    try {
      await switchLink(prior); if (restartCommand) run(restartCommand, prior);
      receipt.rolledBack = true; receipt.rollbackHealthPassed = await health(); receipt.phase = "rolled_back";
    } catch (rollbackError) {
      receipt.phase = "failed"; receipt.rollbackHealthPassed = false;
      receipt.error = `${receipt.error}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
  } else receipt.phase = "failed";
  operationError = error;
} finally {
  await writeReceipt();
}
if (resultMessage) console.log(resultMessage);
if (operationError) throw operationError;
