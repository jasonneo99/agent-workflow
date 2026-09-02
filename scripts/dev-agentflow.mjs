#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, ".agent-workflow", "runtime");
const supervisorHeartbeatPath = path.join(runtimeDir, "supervisor-heartbeat.json");
const workerHeartbeatPath = path.join(runtimeDir, "worker-heartbeat.json");
const dashboardPort = Number.parseInt(process.env.AGENTFLOW_DASHBOARD_PORT ?? "17888", 10);
const workerLimit = Number.parseInt(process.env.AGENTFLOW_WORKER_LIMIT ?? "6", 10);
const workerConcurrency = Number.parseInt(process.env.AGENTFLOW_WORKER_CONCURRENCY ?? "1", 10);
const workerId = process.env.AGENTFLOW_WORKER_ID ?? "supervised-local";
const workerIntervalMs = Number.parseInt(process.env.AGENTFLOW_WORKER_INTERVAL_MS ?? "2000", 10);
const monitorIntervalMs = Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_INTERVAL_MS ?? "5000", 10);
const once = process.argv.includes("--once");

const children = new Map();
let stopping = false;
let ticks = 0;

async function main() {
  await fs.mkdir(runtimeDir, { recursive: true });
  await writeHeartbeat("starting", "checking docker");
  await ensureDocker();
  await writeHeartbeat("starting", "starting services");
  await run("docker", ["compose", "-f", "infra/docker-compose.yml", "up", "-d"]);

  if (once) {
    await writeHeartbeat("stopped", "one-shot service check complete");
    return;
  }

  await startManagedProcesses();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await writeHeartbeat("running", "supervising dashboard and worker");
  console.log(`Agent Workflow supervisor: http://127.0.0.1:${dashboardPort}`);
  console.log("Press Ctrl-C to stop dashboard and worker processes started by this supervisor.");

  while (!stopping) {
    await sleep(monitorIntervalMs);
    await monitor();
  }
}

async function ensureDocker() {
  const info = await run("docker", ["info"], { quiet: true, allowFailure: true });
  if (info.exitCode === 0) {
    return;
  }
  if (await commandExists("colima")) {
    console.log("Docker is not reachable; starting Colima.");
    await run("colima", ["start"]);
    return;
  }
  throw new Error("Docker is not reachable. Start Docker Desktop or Colima, then rerun npm run dev:agentflow.");
}

async function startManagedProcesses() {
  if (await isPortOpen(dashboardPort)) {
    console.log(`Dashboard port ${dashboardPort} is already in use; leaving existing dashboard process alone.`);
  } else {
    startChild("dashboard", ["run", "agentflow", "--", "dashboard", "--port", String(dashboardPort)]);
  }
  if (await isWorkerHeartbeatFresh()) {
    console.log("Worker heartbeat is fresh; leaving existing worker process alone.");
  } else {
    startWorker();
  }
}

async function monitor() {
  ticks += 1;
  for (const [name, child] of children) {
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(name);
      if (!stopping) {
        console.log(`${name} exited; restarting.`);
        if (name === "dashboard" && !(await isPortOpen(dashboardPort))) {
          startChild("dashboard", ["run", "agentflow", "--", "dashboard", "--port", String(dashboardPort)]);
        }
        if (name === "worker") {
          startWorker();
        }
      }
    }
  }
  if (!children.has("dashboard") && !(await isPortOpen(dashboardPort))) {
    console.log("Dashboard port is no longer open; starting dashboard.");
    startChild("dashboard", ["run", "agentflow", "--", "dashboard", "--port", String(dashboardPort)]);
  }
  if (!children.has("worker") && !(await isWorkerHeartbeatFresh())) {
    console.log("Worker heartbeat is stale or missing; starting worker.");
    startWorker();
  }
  await writeHeartbeat("running", "supervising dashboard and worker");
}

function startWorker() {
  startChild("worker", [
    "run",
    "agentflow",
    "--",
    "worker",
    "--watch",
    "--limit",
    String(workerLimit),
    "--interval-ms",
    String(workerIntervalMs),
    "--worker-id",
    workerId,
    "--concurrency",
    String(workerConcurrency),
    "--heartbeat-file",
    workerHeartbeatPath
  ]);
}

function startChild(name, npmArgs) {
  const child = spawn("npm", npmArgs, {
    cwd: rootDir,
    env: { ...process.env, AGENTFLOW_SUPERVISOR: "1" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  children.set(name, child);
}

async function isWorkerHeartbeatFresh() {
  try {
    const heartbeat = JSON.parse(await fs.readFile(workerHeartbeatPath, "utf8"));
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? Date.parse(heartbeat.lastHeartbeatAt) : 0;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : workerIntervalMs;
    const staleAfterMs = Math.max(intervalMs * 3, 15_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    return Boolean(pid && Date.now() - lastHeartbeatAt <= staleAfterMs && isProcessAlive(pid));
  } catch {
    return false;
  }
}

async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  await writeHeartbeat("stopping", "stopping managed processes");
  for (const child of children.values()) {
    child.kill("SIGTERM");
  }
  await sleep(750);
  await writeHeartbeat("stopped", "supervisor stopped");
}

async function writeHeartbeat(status, message) {
  const dashboardManaged = children.has("dashboard");
  const workerManaged = children.has("worker");
  await fs.writeFile(supervisorHeartbeatPath, `${JSON.stringify({
    pid: process.pid,
    status,
    message,
    startedAt: supervisorStartedAt,
    lastHeartbeatAt: new Date().toISOString(),
    ticks,
    dashboardPort,
    dashboardManaged,
    workerManaged,
    workerLimit,
    workerConcurrency,
    workerIntervalMs,
    monitorIntervalMs,
    command: "npm run dev:agentflow"
  }, null, 2)}\n`, "utf8");
}

const supervisorStartedAt = new Date().toISOString();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: options.quiet ? "ignore" : "inherit"
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} exited ${exitCode}`));
        return;
      }
      resolve({ exitCode: exitCode ?? 0 });
    });
  });
}

async function commandExists(command) {
  const result = await run("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    quiet: true,
    allowFailure: true
  });
  return result.exitCode === 0;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  await writeHeartbeat("failed", error instanceof Error ? error.message : String(error)).catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
