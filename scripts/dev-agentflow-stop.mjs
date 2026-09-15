#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, ".agent-workflow", "runtime");
const supervisorHeartbeatPath = path.join(runtimeDir, "supervisor-heartbeat.json");
const workerHeartbeatPath = path.join(runtimeDir, "worker-heartbeat.json");
const workerHeartbeatDir = path.join(runtimeDir, "workers");
const learningProject = process.env.AGENTFLOW_LEARNING_PROJECT
  ? path.resolve(process.cwd(), process.env.AGENTFLOW_LEARNING_PROJECT)
  : process.env.AGENTFLOW_PROJECT
    ? path.resolve(process.cwd(), process.env.AGENTFLOW_PROJECT)
    : rootDir;
const learningHeartbeatPath = path.join(learningProject, ".agent-workflow", "learning", "daemon-status.json");
const dashboardPort = Number.parseInt(process.env.AGENTFLOW_DASHBOARD_PORT ?? "17888", 10);
const dryRun = process.argv.includes("--dry-run");
const pruneStale = process.argv.includes("--prune-stale");

async function main() {
  const supervisorPid = await heartbeatPid(supervisorHeartbeatPath, "supervisor");
  const workerPid = await heartbeatPid(workerHeartbeatPath, "worker");
  const workerRegistryPids = await workerHeartbeatPids();
  const learningPid = await heartbeatPid(learningHeartbeatPath, "learning");
  const dashboardPid = await listenerPid(dashboardPort);
  const matchingPids = await matchingAgentflowPids();

  if (pruneStale) {
    console.log(`Pruned stale worker registrations; ${workerRegistryPids.length} live registration(s) remain.`);
    return;
  }

  const pids = uniqueNumbers([supervisorPid, workerPid, ...workerRegistryPids, learningPid, dashboardPid, ...matchingPids]);
  if (pids.length === 0) {
    console.log("No Agent Workflow supervisor, dashboard, or worker process was found.");
    if (!dryRun) await writeStoppedHeartbeat("stopped", "No running process found.");
    return;
  }

  if (dryRun) {
    console.log(`Would stop verified Agent Workflow processes: ${pids.join(", ")}`);
    return;
  }
  console.log(`Stopping Agent Workflow processes: ${pids.join(", ")}`);
  for (const pid of pids) {
    signal(pid, "SIGTERM");
  }

  await sleep(1500);
  const survivors = [];
  for (const pid of pids) {
    if (await isVerifiedAgentWorkflowProcess(pid)) survivors.push(pid);
  }
  for (const pid of survivors) {
    signal(pid, "SIGKILL");
  }

  if (survivors.length > 0) {
    console.log(`Force-stopped remaining processes: ${survivors.join(", ")}`);
  }
  await writeStoppedHeartbeat("stopped", "Stopped by npm run dev:agentflow:stop.");
  console.log("Agent Workflow dashboard, worker, and learning daemon stopped. Docker services were left running.");
}

async function heartbeatPid(filePath, expectedKind) {
  try {
    const heartbeat = JSON.parse(await fs.readFile(filePath, "utf8"));
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    return pid && await isVerifiedAgentWorkflowProcess(pid, expectedKind) ? pid : null;
  } catch {
    return null;
  }
}

async function workerHeartbeatPids() {
  try {
    const entries = await fs.readdir(workerHeartbeatDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(workerHeartbeatDir, entry.name));
    const pids = [];
    for (const filePath of candidates) {
      const pid = await heartbeatPid(filePath, "worker");
      if (pid) pids.push(pid);
      else if (!dryRun) await fs.unlink(filePath).catch(() => {});
    }
    return pids;
  } catch {
    return [];
  }
}

async function listenerPid(port) {
  try {
    const output = await execFileText("lsof", ["-nP", "-iTCP:" + String(port), "-sTCP:LISTEN", "-Fp"]);
    const pidLine = output.split(/\r?\n/).find((line) => /^p\d+$/.test(line));
    const pid = pidLine ? Number.parseInt(pidLine.slice(1), 10) : null;
    return pid && await isVerifiedAgentWorkflowProcess(pid, "dashboard") ? pid : null;
  } catch {
    return null;
  }
}

async function matchingAgentflowPids() {
  try {
    const output = await execFileText("ps", ["-axo", "pid=,command="]);
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(.+)$/.exec(line);
        return match ? { pid: Number.parseInt(match[1], 10), command: match[2] } : null;
      })
      .filter((entry) => entry && entry.pid !== process.pid)
      .filter((entry) => !entry.command.includes("dev-agentflow-stop.mjs"))
      .filter((entry) => {
        return entry.command.includes("scripts/dev-agentflow.mjs")
          || entry.command.includes("apps/cli/src/index.ts dashboard")
          || entry.command.includes("apps/cli/src/index.ts worker --watch")
          || entry.command.includes("apps/cli/src/index.ts learning-daemon");
      })
      .map((entry) => entry.pid);
    const verified = [];
    for (const pid of candidates) {
      if (await isVerifiedAgentWorkflowProcess(pid)) verified.push(pid);
    }
    return verified;
  } catch {
    return [];
  }
}

function signal(pid, signalName) {
  if (!pid || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, signalName);
  } catch {
    // Process may have exited between discovery and stop.
  }
}

async function isVerifiedAgentWorkflowProcess(pid, expectedKind) {
  try {
    const command = (await execFileText("ps", ["-p", String(pid), "-o", "command="])).trim();
    const kindMatches = {
      supervisor: command.includes("scripts/dev-agentflow.mjs"),
      dashboard: command.includes("apps/cli/src/index.ts dashboard"),
      worker: command.includes("apps/cli/src/index.ts worker --watch"),
      learning: command.includes("apps/cli/src/index.ts learning-daemon")
    };
    const kind = expectedKind ? Boolean(kindMatches[expectedKind]) : Object.values(kindMatches).some(Boolean);
    if (!command || !kind) return false;
    const ownedByRoot = command.includes(rootDir) || (kindMatches.supervisor && await processWorkingDirectory(pid) === rootDir);
    if (!ownedByRoot) return false;
    return true;
  } catch {
    return false;
  }
}

async function processWorkingDirectory(pid) {
  try {
    const output = await execFileText("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const pathLine = output.split(/\r?\n/).find((line) => line.startsWith("n"));
    return pathLine ? pathLine.slice(1) : null;
  } catch {
    return null;
  }
}

async function writeStoppedHeartbeat(status, message) {
  await fs.mkdir(runtimeDir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(supervisorHeartbeatPath, `${JSON.stringify({
    pid: process.pid,
    status,
    message,
    startedAt: now,
    lastHeartbeatAt: now,
    ticks: 0,
    dashboardPort,
    dashboardManaged: false,
    workerManaged: false,
    command: "npm run dev:agentflow"
  }, null, 2)}\n`, "utf8");
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: rootDir }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
