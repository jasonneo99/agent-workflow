#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import YAML from "yaml";
import { supervisedDaemonLaneStatus } from "./supervisor-daemon-lanes.mjs";
import { rotateSupervisorLogs } from "./supervisor-log-rotation.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const bundleMetadata = JSON.parse(await fs.readFile(path.join(rootDir, "agent-workflow.bundle.json"), "utf8"));
const runtimeVersionMetadata = { runtimeVersion: packageMetadata.version ?? "unknown", bundleVersion: bundleMetadata.bundle?.version ?? "unknown", protocolVersions: { runtime: 1, storage: 1, bundle: 1 } };
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true, override: true });
dotenv.config({ path: path.join(rootDir, ".agent-workflow", "runtime.env"), quiet: true, override: true });
const runtimeDir = path.join(rootDir, ".agent-workflow", "runtime");
const supervisorLockPath = path.join(runtimeDir, "supervisor.lock");
const supervisorHeartbeatPath = path.join(runtimeDir, "supervisor-heartbeat.json");
const supervisorEventPath = path.join(runtimeDir, "supervisor-events.jsonl");
const supervisorLogDir = path.join(runtimeDir, "launchd");
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
const workerConcurrency = Number.parseInt(process.env.AGENTFLOW_WORKER_CONCURRENCY ?? "7", 10);
const workerPerProjectConcurrency = Number.parseInt(process.env.AGENTFLOW_WORKER_PER_PROJECT_CONCURRENCY ?? "7", 10);
const workerId = process.env.AGENTFLOW_WORKER_ID ?? "supervised-local";
const workerIntervalMs = Number.parseInt(process.env.AGENTFLOW_WORKER_INTERVAL_MS ?? "2000", 10);
const learningEnabled = process.env.AGENTFLOW_LEARNING_DAEMON !== "0";
const learningMode = normalizeLearningMode(process.env.AGENTFLOW_LEARNING_MODE ?? "apply-approved");
const learningLimit = Number.parseInt(process.env.AGENTFLOW_LEARNING_LIMIT ?? "50", 10);
const learningIntervalMs = Number.parseInt(process.env.AGENTFLOW_LEARNING_INTERVAL_MS ?? "60000", 10);
const learningDaemonId = process.env.AGENTFLOW_LEARNING_DAEMON_ID ?? "supervised-learning";
const queuePartnerEnabled = process.env.AGENTFLOW_QUEUE_PARTNER !== "0";
const queuePartnerIntervalMs = Number.parseInt(process.env.AGENTFLOW_QUEUE_PARTNER_INTERVAL_MS ?? "5000", 10);
const monitorIntervalMs = Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_INTERVAL_MS ?? "5000", 10);
const supervisorLogMaxBytes = positiveNumber(Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_LOG_MAX_BYTES ?? String(10 * 1024 * 1024), 10), 10 * 1024 * 1024);
const supervisorLogKeep = boundedPositiveNumber(Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_LOG_KEEP ?? "5", 10), 5, 20);
const restartWindowMs = positiveNumber(Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_RESTART_WINDOW_MS ?? "60000", 10), 60_000);
const restartLimit = boundedPositiveNumber(Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_RESTART_LIMIT ?? "3", 10), 3, 20);
const restartCooldownMs = positiveNumber(Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_RESTART_COOLDOWN_MS ?? "120000", 10), 120_000);
const restartStableMs = positiveNumber(Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_RESTART_STABLE_MS ?? "120000", 10), 120_000);
const configuredProject = process.env.AGENTFLOW_PROJECT ? path.resolve(process.cwd(), process.env.AGENTFLOW_PROJECT) : null;
const configuredWorkerPoolProfile = process.env.AGENTFLOW_WORKER_POOL_PROFILE;
const once = process.argv.includes("--once");

const children = new Map();
const childStartedAt = new Map();
const restartBreakers = new Map();
const recordedExits = new WeakSet();
const pendingSupervisorEvents = [];
let supervisorEventWriteError = null;
let workerLanes = [];
let stopping = false;
let ticks = 0;

async function main() {
  await fs.mkdir(runtimeDir, { recursive: true });
  await rotateSupervisorLogs(supervisorLogDir, { maxBytes: supervisorLogMaxBytes, keep: supervisorLogKeep });
  const lockOwner = await acquireSupervisorLock();
  if (lockOwner) {
    console.log(`Agent Workflow supervisor is already starting or running (pid ${lockOwner.pid}); leaving it in control.`);
    return;
  }
  const existingSupervisor = await activeSupervisor();
  if (existingSupervisor) {
    console.log(`Agent Workflow supervisor is already running (pid ${existingSupervisor.pid}); leaving it in control.`);
    await releaseSupervisorLock();
    return;
  }
  if (shouldStartLocalStorageServices()) {
    await writeHeartbeat("starting", "checking docker");
    await ensureDocker();
    await writeHeartbeat("starting", "starting local storage services");
    await run("docker", ["compose", "-f", "infra/docker-compose.yml", "up", "-d"]);
  } else {
    await writeHeartbeat("starting", "using configured shared storage");
    console.log("Configured storage points at a shared/non-local host; leaving local Docker storage services stopped.");
  }
  workerLanes = await loadWorkerLanes();
  await pruneDeadWorkerHeartbeatRegistry();

  if (once) {
    await writeHeartbeat("stopped", "one-shot service check complete");
    await releaseSupervisorLock();
    return;
  }

  await startManagedProcesses();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await writeHeartbeat("running", supervisionMessage());
  console.log(`Agent Workflow supervisor: http://127.0.0.1:${dashboardPort}`);
  console.log(`Press Ctrl-C to stop ${supervisedProcessNames()} processes started by this supervisor.`);

  while (!stopping) {
    await sleep(monitorIntervalMs);
    await monitor();
  }
}

async function acquireSupervisorLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(supervisorLockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.close();
      return null;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await fs.readFile(supervisorLockPath, "utf8"));
        const pid = typeof lock.pid === "number" ? lock.pid : null;
        const command = pid ? await processCommand(pid) : "";
        if (pid && command.includes("scripts/dev-agentflow.mjs")) {
          return { pid, command };
        }
      } catch {
        // An incomplete or stale lock is safe to replace after process verification.
      }
      await fs.unlink(supervisorLockPath).catch(() => {});
    }
  }
  throw new Error("Could not acquire the Agent Workflow supervisor lock.");
}

async function releaseSupervisorLock() {
  try {
    const lock = JSON.parse(await fs.readFile(supervisorLockPath, "utf8"));
    if (lock.pid === process.pid) await fs.unlink(supervisorLockPath);
  } catch {
    // Missing or replaced locks do not require cleanup by this process.
  }
}

async function activeSupervisor() {
  try {
    const heartbeat = JSON.parse(await fs.readFile(supervisorHeartbeatPath, "utf8"));
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const status = typeof heartbeat.status === "string" ? heartbeat.status : "";
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? Date.parse(heartbeat.lastHeartbeatAt) : 0;
    const staleAfterMs = Math.max(positiveNumber(heartbeat.monitorIntervalMs, monitorIntervalMs) * 3, 15_000);
    if (!pid || pid === process.pid || status === "stopped" || status === "stopping" || status === "failed" || Date.now() - lastHeartbeatAt > staleAfterMs) return null;
    assertCompatibleHeartbeat(heartbeat, "supervisor");
    const command = await processCommand(pid);
    return command.includes(rootDir) && command.includes("scripts/dev-agentflow.mjs") ? { pid, command } : null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing mixed-version")) throw error;
    return null;
  }
}

function processCommand(pid) {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-p", String(pid), "-o", "command="], { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? output.trim() : ""));
  });
}

function shouldStartLocalStorageServices() {
  if (process.env.AGENTFLOW_START_LOCAL_STORAGE === "1" || process.env.AGENTFLOW_START_LOCAL_STORAGE === "true") {
    return true;
  }
  if (process.env.AGENTFLOW_START_LOCAL_STORAGE === "0" || process.env.AGENTFLOW_START_LOCAL_STORAGE === "false") {
    return false;
  }
  return [process.env.DATABASE_URL, process.env.REDIS_URL, process.env.OBJECT_STORAGE_ENDPOINT]
    .filter(Boolean)
    .some((value) => isLocalUrl(value));
}

function isLocalUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing mixed-version")) throw error;
    return false;
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
  await startDashboardIfNeeded();
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
  if (queuePartnerEnabled) {
    startQueuePartner();
  }
}

async function monitor() {
  ticks += 1;
  await rotateSupervisorLogs(supervisorLogDir, { maxBytes: supervisorLogMaxBytes, keep: supervisorLogKeep });
  resetStableRestartBreakers();
  for (const [name, child] of children) {
    if (child.exitCode !== null || child.signalCode !== null) {
      children.delete(name);
      if (!stopping) {
        if (name === "dashboard") {
          await startDashboardIfNeeded();
        }
        if (name.startsWith("worker:")) {
          const lane = workerLanes.find((item) => `worker:${item.id}` === name);
          if (lane) startWorker(lane);
        }
        if (name === "learning-daemon" && learningEnabled) {
          if (startLearningDaemon()) console.log("Learning daemon exited; restarting.");
        }
        if (name === "queue-partner" && queuePartnerEnabled) {
          if (startQueuePartner()) console.log("Queue Partner exited; restarting.");
        }
      }
    }
  }
  if (!children.has("dashboard")) {
    await startDashboardIfNeeded();
  }
  for (const lane of workerLanes) {
    if (!children.has(`worker:${lane.id}`) && !(await isWorkerHeartbeatFresh(lane.heartbeatPath, lane.intervalMs))) {
      if (startWorker(lane)) console.log(`Worker lane ${lane.id} heartbeat is stale or missing; starting worker.`);
    }
  }
  if (learningEnabled && !children.has("learning-daemon") && !(await isLearningHeartbeatFresh())) {
    if (startLearningDaemon()) console.log("Learning daemon heartbeat is stale or missing; starting learning daemon.");
  }
  if (queuePartnerEnabled && !children.has("queue-partner")) {
    if (startQueuePartner()) console.log("Queue Partner coordinator is not running; starting it.");
  }
  await pruneDeadWorkerHeartbeatRegistry();
  await flushSupervisorEvents();
  const held = activeRestartBreakers();
  const journalDegraded = Boolean(supervisorEventWriteError || pendingSupervisorEvents.length);
  await writeHeartbeat(held.length || journalDegraded ? "degraded" : "running", supervisionMessage(held, journalDegraded));
}

async function pruneDeadWorkerHeartbeatRegistry() {
  let entries;
  try {
    entries = await fs.readdir(workerHeartbeatDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const heartbeatPath = path.join(workerHeartbeatDir, entry.name);
    try {
      const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8"));
      const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
      const command = pid ? await processCommand(pid) : "";
      const ownsLiveWorker = command.includes(rootDir) && /apps\/cli\/src\/index\.ts\s+worker\b/u.test(command);
      if (!ownsLiveWorker) await fs.unlink(heartbeatPath);
    } catch {
      await fs.unlink(heartbeatPath).catch(() => {});
    }
  }
}

async function startDashboardIfNeeded() {
  if (children.has("dashboard")) {
    return;
  }
  if (await isPortOpen(dashboardPort)) {
    console.log(`Dashboard port ${dashboardPort} is already in use; leaving existing dashboard process alone.`);
    return;
  }
  const started = startChild("dashboard", ["run", "agentflow", "--", "dashboard", "--port", String(dashboardPort)]);
  if (started) console.log("Dashboard port is no longer open; starting dashboard.");
  return started;
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
    "--per-project-concurrency",
    String(lane.perProjectConcurrency),
    "--heartbeat-file",
    lane.heartbeatPath
  ];
  if (lane.projectRoot) {
    args.push("--project", lane.projectRoot);
  }
  if (!lane.projectScoped) {
    args.push("--all-projects");
  }
  return startChild(`worker:${lane.id}`, args);
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
  return startChild("learning-daemon", args);
}

function startQueuePartner() {
  return startChild("queue-partner", [
    "run",
    "agentflow",
    "--",
    "queue-coordinator",
    "--all-queued-projects",
    "--manage-self-repair",
    "--autonomous-recovery",
    "--execute",
    "--watch",
    "--interval-ms",
    String(positiveNumber(queuePartnerIntervalMs, 5000))
  ]);
}

function supervisedProcessNames() {
  return ["dashboard", "worker", learningEnabled ? "learning daemon" : null, queuePartnerEnabled ? "Queue Partner" : null]
    .filter(Boolean)
    .join(", ");
}

function supervisionMessage(held = activeRestartBreakers(), journalDegraded = Boolean(supervisorEventWriteError || pendingSupervisorEvents.length)) {
  const conditions = [];
  if (held.length) conditions.push(`restart held for ${held.map((item) => item.name).join(", ")}`);
  if (journalDegraded) conditions.push("supervisor event journal awaiting retry");
  return `supervising ${supervisedProcessNames()}${conditions.length ? `; ${conditions.join("; ")}` : ""}`;
}

function startChild(name, npmArgs) {
  if (!canStartChild(name)) return false;
  const child = spawn("npm", npmArgs, {
    cwd: rootDir,
    env: { ...process.env, AGENTFLOW_SUPERVISOR: "1" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  children.set(name, child);
  childStartedAt.set(name, Date.now());
  child.once("exit", (exitCode, signal) => {
    recordChildExit(name, child, exitCode, signal);
    if (children.get(name) === child) {
      children.delete(name);
      childStartedAt.delete(name);
    }
  });
  child.once("error", (error) => {
    recordChildExit(name, child, null, error?.code ?? "spawn-error");
    if (children.get(name) === child) {
      children.delete(name);
      childStartedAt.delete(name);
    }
  });
  return true;
}

function recordChildExit(name, child, exitCode, signal) {
  if (stopping || recordedExits.has(child)) return;
  recordedExits.add(child);
  const now = Date.now();
  const startedAt = childStartedAt.get(name) ?? now;
  const previous = restartBreakers.get(name);
  const priorExits = now - startedAt >= restartStableMs ? [] : previous?.exits ?? [];
  const exits = [...priorExits.filter((at) => now - at <= restartWindowMs), now];
  const openUntil = exits.length >= restartLimit ? now + restartCooldownMs : 0;
  restartBreakers.set(name, { exits, openUntil, lastExitAt: now, exitCode, signal });
  if (openUntil) {
    console.error(`${name} exited ${exits.length} times inside ${restartWindowMs}ms; holding restarts until ${new Date(openUntil).toISOString()}.`);
    queueSupervisorEvent("restart_breaker_opened", name, {
      attemptsInWindow: exits.length,
      retryAfter: new Date(openUntil).toISOString(),
      exitCode,
      signal
    });
  }
}

function canStartChild(name) {
  const breaker = restartBreakers.get(name);
  if (!breaker?.openUntil) return true;
  const now = Date.now();
  if (now < breaker.openUntil) return false;
  restartBreakers.delete(name);
  console.log(`${name} restart cooldown elapsed; allowing one bounded recovery attempt.`);
  queueSupervisorEvent("restart_recovery_attempted", name, { attemptsInWindow: breaker.exits.length });
  return true;
}

function resetStableRestartBreakers() {
  const now = Date.now();
  for (const [name, startedAt] of childStartedAt) {
    if (children.has(name) && now - startedAt >= restartStableMs && restartBreakers.has(name)) {
      restartBreakers.delete(name);
      queueSupervisorEvent("restart_breaker_recovered", name, { stableForMs: now - startedAt });
    }
  }
}

function activeRestartBreakers() {
  const now = Date.now();
  return [...restartBreakers.entries()]
    .filter(([, breaker]) => breaker.openUntil > now)
    .map(([name, breaker]) => ({ name, ...breaker }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function queueSupervisorEvent(action, target, metadata) {
  pendingSupervisorEvents.push({
    id: randomUUID(),
    action,
    target,
    metadata,
    createdAt: new Date().toISOString()
  });
  if (pendingSupervisorEvents.length > 100) pendingSupervisorEvents.splice(0, pendingSupervisorEvents.length - 100);
}

async function flushSupervisorEvents() {
  while (pendingSupervisorEvents.length) {
    try {
      await fs.appendFile(supervisorEventPath, `${JSON.stringify(pendingSupervisorEvents[0])}\n`, "utf8");
      pendingSupervisorEvents.shift();
      supervisorEventWriteError = null;
    } catch (error) {
      supervisorEventWriteError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
  return true;
}

async function isWorkerHeartbeatFresh(filePath = workerHeartbeatPath, fallbackIntervalMs = workerIntervalMs) {
  try {
    const heartbeat = JSON.parse(await fs.readFile(filePath, "utf8"));
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? Date.parse(heartbeat.lastHeartbeatAt) : 0;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : fallbackIntervalMs;
    const staleAfterMs = Math.max(intervalMs * 3, 15_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const freshAndAlive = Boolean(pid && Date.now() - lastHeartbeatAt <= staleAfterMs && isProcessAlive(pid));
    if (freshAndAlive) assertCompatibleHeartbeat(heartbeat, `worker (${filePath})`);
    return freshAndAlive;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing mixed-version")) throw error;
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
    const freshAndAlive = Boolean(pid && Date.now() - lastHeartbeatAt <= staleAfterMs && isProcessAlive(pid) && status !== "stopped" && status !== "stopping" && status !== "failed");
    if (freshAndAlive) assertCompatibleHeartbeat(heartbeat, "learning daemon");
    return freshAndAlive;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing mixed-version")) throw error;
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
  await releaseSupervisorLock();
}

async function writeHeartbeat(status, message) {
  const dashboardManaged = children.has("dashboard");
  const workerManaged = [...children.keys()].some((name) => name.startsWith("worker:"));
  const learningManaged = children.has("learning-daemon");
  const queuePartnerManaged = children.has("queue-partner");
  await fs.writeFile(supervisorHeartbeatPath, `${JSON.stringify({
    ...runtimeVersionMetadata,
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
    queuePartnerEnabled,
    queuePartnerManaged,
    queuePartnerIntervalMs: positiveNumber(queuePartnerIntervalMs, 5000),
    restartPolicy: {
      limit: restartLimit,
      windowMs: restartWindowMs,
      cooldownMs: restartCooldownMs,
      stableMs: restartStableMs
    },
    restartBreakers: activeRestartBreakers().map((breaker) => ({
      name: breaker.name,
      attemptsInWindow: breaker.exits.length,
      lastExitAt: new Date(breaker.lastExitAt).toISOString(),
      retryAfter: new Date(breaker.openUntil).toISOString(),
      exitCode: breaker.exitCode,
      signal: breaker.signal
    })),
    supervisorEventJournal: {
      path: supervisorEventPath,
      pending: pendingSupervisorEvents.length,
      status: supervisorEventWriteError ? "degraded" : "ready",
      error: supervisorEventWriteError
    },
    daemonLanes: supervisedDaemonLaneStatus(learningEnabled),
    workerLimit,
    workerConcurrency,
    workerPerProjectConcurrency,
    workerPoolProfile: configuredWorkerPoolProfile ?? null,
    workerLanes: workerLanes.map((lane) => ({
      id: lane.id,
      workerId: lane.workerId,
      projectRoot: lane.projectRoot,
      projectScoped: lane.projectScoped,
      limit: lane.limit,
      concurrency: lane.concurrency,
      perProjectConcurrency: lane.perProjectConcurrency,
      leaseSeconds: lane.leaseSeconds,
      intervalMs: lane.intervalMs,
      heartbeatPath: lane.heartbeatPath
    })),
    workerIntervalMs,
    monitorIntervalMs,
    command: "npm run dev:agentflow"
  }, null, 2)}\n`, "utf8");
}

function assertCompatibleHeartbeat(heartbeat, source) {
  const actual = heartbeat?.protocolVersions;
  const expected = runtimeVersionMetadata.protocolVersions;
  if (actual?.runtime !== expected.runtime || actual?.storage !== expected.storage || actual?.bundle !== expected.bundle) {
    throw new Error(`Refusing mixed-version ${source}: expected protocol ${JSON.stringify(expected)}, received ${JSON.stringify(actual ?? null)}.`);
  }
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
      perProjectConcurrency: boundedPositiveNumber(workerPerProjectConcurrency, 1, 16),
      leaseSeconds: positiveNumber(Number.parseInt(process.env.AGENTFLOW_WORKER_LEASE_SECONDS ?? "120", 10), 120),
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
        perProjectConcurrency: boundedPositiveNumber(numberValue(lane.per_project_concurrency) ?? numberValue(profile.per_project_concurrency) ?? numberValue(pool.per_project_concurrency) ?? workerPerProjectConcurrency, 1, 16),
        leaseSeconds: positiveNumber(numberValue(lane.lease_seconds) ?? numberValue(profile.lease_seconds) ?? numberValue(pool.lease_seconds) ?? 120, 120),
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
      perProjectConcurrency: boundedPositiveNumber(workerPerProjectConcurrency, 1, 16),
      leaseSeconds: positiveNumber(Number.parseInt(process.env.AGENTFLOW_WORKER_LEASE_SECONDS ?? "120", 10), 120),
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
  await releaseSupervisorLock();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
