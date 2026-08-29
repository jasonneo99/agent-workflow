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
const dashboardPort = Number.parseInt(process.env.AGENTFLOW_DASHBOARD_PORT ?? "17888", 10);

async function main() {
  const supervisorPid = await heartbeatPid(supervisorHeartbeatPath);
  const workerPid = await heartbeatPid(workerHeartbeatPath);
  const dashboardPid = await listenerPid(dashboardPort);
  const matchingPids = await matchingAgentflowPids();

  const pids = uniqueNumbers([supervisorPid, workerPid, dashboardPid, ...matchingPids]);
  if (pids.length === 0) {
    console.log("No Agent Workflow supervisor, dashboard, or worker process was found.");
    await writeStoppedHeartbeat("stopped", "No running process found.");
    return;
  }

  console.log(`Stopping Agent Workflow processes: ${pids.join(", ")}`);
  for (const pid of pids) {
    signal(pid, "SIGTERM");
  }

  await sleep(1500);
  const survivors = pids.filter((pid) => isProcessAlive(pid));
  for (const pid of survivors) {
    signal(pid, "SIGKILL");
  }

  if (survivors.length > 0) {
    console.log(`Force-stopped remaining processes: ${survivors.join(", ")}`);
  }
  await writeStoppedHeartbeat("stopped", "Stopped by npm run dev:agentflow:stop.");
  console.log("Agent Workflow dashboard and worker stopped. Docker services were left running.");
}

async function heartbeatPid(filePath) {
  try {
    const heartbeat = JSON.parse(await fs.readFile(filePath, "utf8"));
    return typeof heartbeat.pid === "number" ? heartbeat.pid : null;
  } catch {
    return null;
  }
}

async function listenerPid(port) {
  try {
    const output = await execFileText("lsof", ["-nP", "-iTCP:" + String(port), "-sTCP:LISTEN", "-Fp"]);
    const pidLine = output.split(/\r?\n/).find((line) => /^p\d+$/.test(line));
    return pidLine ? Number.parseInt(pidLine.slice(1), 10) : null;
  } catch {
    return null;
  }
}

async function matchingAgentflowPids() {
  try {
    const output = await execFileText("ps", ["-axo", "pid=,command="]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(.+)$/.exec(line);
        return match ? { pid: Number.parseInt(match[1], 10), command: match[2] } : null;
      })
      .filter((entry) => entry && entry.pid !== process.pid)
      .filter((entry) => entry.command.includes(rootDir))
      .filter((entry) => !entry.command.includes("dev-agentflow-stop.mjs"))
      .filter((entry) => {
        return entry.command.includes("scripts/dev-agentflow.mjs")
          || entry.command.includes("apps/cli/src/index.ts dashboard")
          || entry.command.includes("apps/cli/src/index.ts worker --watch");
      })
      .map((entry) => entry.pid);
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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
