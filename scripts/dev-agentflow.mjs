#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, ".agent-workflow", "runtime");
const supervisorHeartbeatPath = path.join(runtimeDir, "supervisor-heartbeat.json");
const workerHeartbeatPath = path.join(runtimeDir, "worker-heartbeat.json");
const workerHeartbeatDir = path.join(runtimeDir, "workers");
const learningScope = normalizeLearningScope(process.env.AGENTFLOW_LEARNING_SCOPE ?? (process.env.AGENTFLOW_LEARNING_ALL_PROJECTS === "0" ? "project" : "all-projects"));
const learningProject = process.env.AGENTFLOW_LEARNING_PROJECT
  ? path.resolve(process.cwd(), process.env.AGENTFLOW_LEARNING_PROJECT)
  : process.env.AGENTFLOW_PROJECT
    ? path.resolve(process.cwd(), process.env.AGENTFLOW_PROJECT)
    : rootDir;
const learningHeartbeatPath = path.join(learningProject, ".agent-workflow", "learning", "daemon-status.json");
const dashboardPort = Number.parseInt(process.env.AGENTFLOW_DASHBOARD_PORT ?? "17888", 10);
const workerLimit = Number.parseInt(process.env.AGENTFLOW_WORKER_LIMIT ?? "6", 10);
const workerConcurrency = Number.parseInt(process.env.AGENTFLOW_WORKER_CONCURRENCY ?? "1", 10);
const workerId = process.env.AGENTFLOW_WORKER_ID ?? "supervised-local";
const workerIntervalMs = Number.parseInt(process.env.AGENTFLOW_WORKER_INTERVAL_MS ?? "2000", 10);
const learningEnabled = process.env.AGENTFLOW_LEARNING_DAEMON !== "0";
const learningMode = normalizeLearningMode(process.env.AGENTFLOW_LEARNING_MODE ?? "apply-approved");
const learningLimit = Number.parseInt(process.env.AGENTFLOW_LEARNING_LIMIT ?? "50", 10);
const learningIntervalMs = Number.parseInt(process.env.AGENTFLOW_LEARNING_INTERVAL_MS ?? "60000", 10);
const learningDaemonId = process.env.AGENTFLOW_LEARNING_DAEMON_ID ?? "supervised-learning";
const monitorIntervalMs = Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_INTERVAL_MS ?? "5000", 10);
const configuredProject = process.env.AGENTFLOW_PROJECT ? path.resolve(process.cwd(), process.env.AGENTFLOW_PROJECT) : null;
const configuredWorkerPoolProfile = process.env.AGENTFLOW_WORKER_POOL_PROFILE;
const once = process.argv.includes("--once");

const children = new Map();
let workerLanes = [];
let stopping = false;
let ticks = 0;

async function main() {
  await fs.mkdir(runtimeDir, { recursive: true });
  await writeHeartbeat("starting", "checking docker");
  await ensureDocker();
  await writeHeartbeat("starting", "starting services");
  await run("docker", ["compose", "-f", "infra/docker-compose.yml", "up", "-d"]);
  workerLanes = await loadWorkerLanes();

  if (once) {
    await writeHeartbeat("stopped", "one-shot service check complete");
    return;
  }

  await startManagedProcesses();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await writeHeartbeat("running", learningEnabled ? "supervising dashboard, worker, and learning daemon" : "supervising dashboard and worker");
  console.log(`Agent Workflow supervisor: http://127.0.0.1:${dashboardPort}`);
  console.log(`Press Ctrl-C to stop dashboard, worker${learningEnabled ? ", and learning daemon" : ""} processes started by this supervisor.`);

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
  const staleLanes = [];
  for (const lane of workerLanes) {
    if (await isWorkerHeartbeatFresh(lane.heartbeatPath, lane.intervalMs)) {
      console.log(`Worker lane ${lane.id} heartbeat is fresh; leaving existing worker process alone.`);
    } else {
      staleLanes.push(lane);
    }
  }
  if (staleLanes.length === 0) {
    console.log("Worker heartbeat is fresh; leaving existing worker process alone.");
  } else {
    for (const lane of staleLanes) {
      startWorker(lane);
    }
  }
  if (learningEnabled) {
    if (await isLearningHeartbeatFresh()) {
      console.log(`Learning daemon heartbeat is fresh for ${learningProject}; leaving existing daemon process alone.`);
    } else {
      startLearningDaemon();
    }
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
        if (name.startsWith("worker:")) {
          const lane = workerLanes.find((item) => `worker:${item.id}` === name);
          if (lane) {
            startWorker(lane);
          }
        }
        if (name === "learning-daemon" && learningEnabled) {
          startLearningDaemon();
        }
      }
    }
  }
  if (!children.has("dashboard") && !(await isPortOpen(dashboardPort))) {
    console.log("Dashboard port is no longer open; starting dashboard.");
    startChild("dashboard", ["run", "agentflow", "--", "dashboard", "--port", String(dashboardPort)]);
  }
  for (const lane of workerLanes) {
    if (!children.has(`worker:${lane.id}`) && !(await isWorkerHeartbeatFresh(lane.heartbeatPath, lane.intervalMs))) {
      console.log(`Worker lane ${lane.id} heartbeat is stale or missing; starting worker.`);
      startWorker(lane);
    }
  }
  if (learningEnabled && !children.has("learning-daemon") && !(await isLearningHeartbeatFresh())) {
    console.log("Learning daemon heartbeat is stale or missing; starting learning daemon.");
    startLearningDaemon();
  }
  await writeHeartbeat("running", learningEnabled ? "supervising dashboard, worker, and learning daemon" : "supervising dashboard and worker");
}

function startWorker(lane) {
  const args = [
    "run",
    "agentflow",
    "--",
    "worker",
    "--watch",
    "--limit",
    String(lane.limit),
    "--interval-ms",
    String(lane.intervalMs),
    "--worker-id",
    lane.workerId,
    "--lease-seconds",
    String(lane.leaseSeconds),
    "--concurrency",
    String(lane.concurrency),
    "--heartbeat-file",
    lane.heartbeatPath
  ];
  if (lane.projectRoot) {
    args.push("--project", lane.projectRoot);
  }
  if (!lane.projectScoped) {
    args.push("--all-projects");
  }
  startChild(`worker:${lane.id}`, args);
}

function startLearningDaemon() {
  const args = [
    "run",
    "agentflow",
    "--",
    "learning-daemon",
    "--mode",
    learningMode,
    "--limit",
    String(positiveNumber(learningLimit, 50)),
    "--interval-ms",
    String(positiveNumber(learningIntervalMs, 60000)),
    "--daemon-id",
    learningDaemonId,
    "--heartbeat-file",
    learningHeartbeatPath
  ];
  if (learningScope === "all-projects") {
    args.push("--all-projects", "--project", learningProject);
  } else {
    args.push("--project", learningProject);
  }
  startChild("learning-daemon", args);
}

function startChild(name, npmArgs) {
  const child = spawn("npm", npmArgs, {
    cwd: rootDir,
    env: { ...process.env, AGENTFLOW_SUPERVISOR: "1" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  children.set(name, child);
}

async function isWorkerHeartbeatFresh(filePath = workerHeartbeatPath, fallbackIntervalMs = workerIntervalMs) {
  try {
    const heartbeat = JSON.parse(await fs.readFile(filePath, "utf8"));
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? Date.parse(heartbeat.lastHeartbeatAt) : 0;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : fallbackIntervalMs;
    const staleAfterMs = Math.max(intervalMs * 3, 15_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    return Boolean(pid && Date.now() - lastHeartbeatAt <= staleAfterMs && isProcessAlive(pid));
  } catch {
    return false;
  }
}

async function isLearningHeartbeatFresh() {
  try {
    const heartbeat = JSON.parse(await fs.readFile(learningHeartbeatPath, "utf8"));
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? Date.parse(heartbeat.lastHeartbeatAt) : 0;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : learningIntervalMs;
    const staleAfterMs = Math.max(intervalMs * 3, 30_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const status = typeof heartbeat.status === "string" ? heartbeat.status : "";
    return Boolean(pid && Date.now() - lastHeartbeatAt <= staleAfterMs && isProcessAlive(pid) && status !== "stopped" && status !== "stopping" && status !== "failed");
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
  const workerManaged = [...children.keys()].some((name) => name.startsWith("worker:"));
  const learningManaged = children.has("learning-daemon");
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
    learningManaged,
    learningEnabled,
    learningScope,
    learningProject,
    learningMode,
    learningIntervalMs: positiveNumber(learningIntervalMs, 60000),
    learningLimit: positiveNumber(learningLimit, 50),
    learningHeartbeatPath,
    workerLimit,
    workerConcurrency,
    workerPoolProfile: configuredWorkerPoolProfile ?? null,
    workerLanes: workerLanes.map((lane) => ({
      id: lane.id,
      workerId: lane.workerId,
      projectRoot: lane.projectRoot,
      projectScoped: lane.projectScoped,
      limit: lane.limit,
      concurrency: lane.concurrency,
      leaseSeconds: lane.leaseSeconds,
      intervalMs: lane.intervalMs,
      heartbeatPath: lane.heartbeatPath
    })),
    workerIntervalMs,
    monitorIntervalMs,
    command: "npm run dev:agentflow"
  }, null, 2)}\n`, "utf8");
}

const supervisorStartedAt = new Date().toISOString();

async function loadWorkerLanes() {
  if (!configuredProject) {
    return [{
      id: "default",
      workerId,
      projectRoot: null,
      projectScoped: false,
      limit: positiveNumber(workerLimit, 6),
      concurrency: boundedPositiveNumber(workerConcurrency, 1, 16),
      leaseSeconds: positiveNumber(Number.parseInt(process.env.AGENTFLOW_WORKER_LEASE_SECONDS ?? "900", 10), 900),
      intervalMs: positiveNumber(workerIntervalMs, 2000),
      heartbeatPath: workerHeartbeatPath
    }];
  }

  try {
    const configPath = path.join(configuredProject, ".agent-workflow", "project.yaml");
    const config = YAML.parse(await fs.readFile(configPath, "utf8")) ?? {};
    const pool = config.execution?.worker_pool ?? {};
    const profileName = configuredWorkerPoolProfile ?? pool.default_profile ?? "local";
    const profile = pool.profiles?.[profileName] ?? {};
    const rawLanes = Array.isArray(profile.lanes) && profile.lanes.length ? profile.lanes : [{ id: "default" }];
    return rawLanes.map((lane, index) => {
      const id = stringValue(lane.id) ?? `lane-${index + 1}`;
      const laneWorkerId = stringValue(lane.worker_id) ?? stringValue(profile.worker_id) ?? stringValue(pool.worker_id) ?? `${profileName}-${id}`;
      const intervalMs = positiveNumber(numberValue(lane.interval_ms) ?? numberValue(profile.interval_ms) ?? numberValue(pool.interval_ms) ?? workerIntervalMs, 2000);
      const projectScoped = booleanValue(lane.project_scoped) ?? booleanValue(profile.project_scoped) ?? booleanValue(pool.project_scoped) ?? true;
      return {
        id,
        workerId: laneWorkerId,
        projectRoot: configuredProject,
        projectScoped,
        limit: positiveNumber(numberValue(lane.limit) ?? numberValue(profile.limit) ?? numberValue(pool.limit) ?? workerLimit, 6),
        concurrency: boundedPositiveNumber(numberValue(lane.concurrency) ?? numberValue(profile.concurrency) ?? numberValue(pool.concurrency) ?? workerConcurrency, 1, 16),
        leaseSeconds: positiveNumber(numberValue(lane.lease_seconds) ?? numberValue(profile.lease_seconds) ?? numberValue(pool.lease_seconds) ?? 900, 900),
        intervalMs,
        heartbeatPath: laneHeartbeatPath(laneWorkerId, index)
      };
    });
  } catch (error) {
    console.log(`Could not load worker pool profile from ${configuredProject}; using one default project-scoped worker. ${error instanceof Error ? error.message : String(error)}`);
    return [{
      id: "default",
      workerId,
      projectRoot: configuredProject,
      projectScoped: true,
      limit: positiveNumber(workerLimit, 6),
      concurrency: boundedPositiveNumber(workerConcurrency, 1, 16),
      leaseSeconds: positiveNumber(Number.parseInt(process.env.AGENTFLOW_WORKER_LEASE_SECONDS ?? "900", 10), 900),
      intervalMs: positiveNumber(workerIntervalMs, 2000),
      heartbeatPath: workerHeartbeatPath
    }];
  }
}

function laneHeartbeatPath(laneWorkerId, index) {
  if (index === 0) {
    return workerHeartbeatPath;
  }
  return path.join(workerHeartbeatDir, `${safeFileSegment(laneWorkerId)}.json`);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value) {
  return Number.isFinite(value) ? value : null;
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : null;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boundedPositiveNumber(value, fallback, max) {
  return Math.min(positiveNumber(value, fallback), max);
}

function normalizeLearningMode(value) {
  return value === "observe" || value === "propose" || value === "apply-approved" ? value : "apply-approved";
}

function normalizeLearningScope(value) {
  return value === "project" ? "project" : "all-projects";
}

function safeFileSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "worker";
}

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
