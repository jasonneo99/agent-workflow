#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));
const baseUrl = new URL(options.url ?? "http://127.0.0.1:17888");
if (!["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)) throw new Error("Live runtime verification is limited to a loopback dashboard.");
const sourcePaths = options.source.length ? options.source : ["scripts/dev-agentflow.mjs"];
const runtimeRole = options.role ?? (sourcePaths.every((file) => file === "scripts/dev-agentflow.mjs") ? "supervisor" : "dashboard");
const heartbeatPath = path.join(root, ".agent-workflow", "runtime", "supervisor-heartbeat.json");
const reportPath = path.join(root, ".agent-workflow", "runtime", "live-runtime-verification.json");
const checks = [];
const routeTimings = [];
const previousRouteTimings = await fs.readFile(reportPath, "utf8").then((text) => JSON.parse(text).routeTimings ?? [], () => []);

const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8"));
assertCheck("supervisor-heartbeat", heartbeat.status === "running" && heartbeat.restartBreakers?.length === 0, {
  status: heartbeat.status,
  restartBreakers: heartbeat.restartBreakers?.length ?? null
});
assertCheck("supervisor-heartbeat-fresh", Date.now() - Date.parse(heartbeat.lastHeartbeatAt) <= Math.max(Number(heartbeat.monitorIntervalMs ?? 5000) * 3, 15_000), {
  lastHeartbeatAt: heartbeat.lastHeartbeatAt
});

const runtimePid = runtimeRole === "supervisor" ? heartbeat.pid : Number.parseInt(execFileSync("lsof", ["-nP", `-iTCP:${baseUrl.port || "80"}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split(/\s+/u)[0], 10);
const processCommand = execFileSync("ps", ["-p", String(runtimePid), "-o", "command="], { encoding: "utf8" }).trim();
const expectedCommand = runtimeRole === "supervisor" ? "scripts/dev-agentflow.mjs" : "apps/cli/src/index.ts dashboard";
assertCheck(`${runtimeRole}-process-identity`, processCommand.includes(root) && processCommand.includes(expectedCommand), { pid: runtimePid });
const processStartedAt = Date.parse(execFileSync("ps", ["-p", String(runtimePid), "-o", "lstart="], { encoding: "utf8" }).trim());
const runtimeStartedAt = Number.isFinite(processStartedAt) ? new Date(processStartedAt).toISOString() : null;
assertCheck(`${runtimeRole}-start-time`, Number.isFinite(processStartedAt) && (runtimeRole !== "supervisor" || Math.abs(processStartedAt - Date.parse(heartbeat.startedAt)) <= 10_000), { startedAt: runtimeStartedAt });

const sourceEvidence = [];
for (const relative of sourcePaths) {
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error(`Source path must be project-relative: ${relative}`);
  const absolute = path.join(root, relative);
  const stat = await fs.stat(absolute);
  const loaded = stat.mtimeMs <= processStartedAt;
  sourceEvidence.push({ path: relative, modifiedAt: new Date(stat.mtimeMs).toISOString(), loadedBeforeProcessStart: loaded });
  assertCheck(`source-loaded:${relative}`, loaded, { modifiedAt: new Date(stat.mtimeMs).toISOString(), processStartedAt: new Date(processStartedAt).toISOString() });
}

const info = await readJson("/api/info");
assertCheck("runtime-root", info.app?.rootDir === root, { rootDir: info.app?.rootDir });
assertCheck("runtime-version", info.app?.version === heartbeat.runtimeVersion && info.bundle?.version === heartbeat.bundleVersion, {
  app: info.app?.version,
  runtime: heartbeat.runtimeVersion,
  bundle: info.bundle?.version
});
assertCheck("managed-lanes", heartbeat.dashboardManaged && heartbeat.workerManaged && heartbeat.queuePartnerManaged, {
  dashboard: heartbeat.dashboardManaged,
  worker: heartbeat.workerManaged,
  queuePartner: heartbeat.queuePartnerManaged
});

const [queue, history, queueHtml] = await Promise.all([
  readJson("/api/queue"),
  readJson("/api/queue-history?range=1h"),
  readText("/queue")
]);
assertCheck("queue-contract", Array.isArray(queue), { items: Array.isArray(queue) ? queue.length : null });
assertCheck("minute-history-contract", history.resolution === "minute" && Array.isArray(history.points), { resolution: history.resolution, points: history.points?.length ?? null });
assertCheck("queue-ui-contract", queueHtml.includes("queue-history-chart") && queueHtml.includes("Stacked minute bars") && queueHtml.includes("queue-card-list"), {});
for (const timing of routeTimings) {
  const budgetMs = timing.route.includes("queue-history") ? 2_000 : timing.route === "/api/info" ? 2_000 : 8_000;
  assertCheck(`route-latency:${timing.route}`, timing.durationMs <= budgetMs, { durationMs: timing.durationMs, budgetMs });
}

const layouts = await probeResponsiveLayout(new URL("/queue", baseUrl).href);
for (const layout of layouts) assertCheck(`responsive-layout:${layout.width}`, !layout.horizontalOverflow, layout);

const report = {
  kind: "agentflow_live_runtime_verification",
  generatedAt: new Date().toISOString(),
  status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
  runtime: { role: runtimeRole, pid: runtimePid, startedAt: runtimeStartedAt, root, version: heartbeat.runtimeVersion },
  sourceEvidence,
  routeTimings,
  previousRouteTimings,
  checks,
  layouts,
  acceptanceClaimed: false
};
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (report.status !== "pass") process.exitCode = 1;

function parseArgs(values) {
  const result = { source: [], url: null, role: null };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--source") result.source.push(values[++index]);
    else if (values[index] === "--url") result.url = values[++index];
    else if (values[index] === "--role") result.role = values[++index];
    else throw new Error(`Unsupported argument: ${values[index]}`);
  }
  if (result.source.some((value) => !value)) throw new Error("Each --source requires a path.");
  if (result.role && !["supervisor", "dashboard"].includes(result.role)) throw new Error("--role must be supervisor or dashboard.");
  return result;
}

function assertCheck(name, passed, evidence) {
  checks.push({ name, status: passed ? "pass" : "fail", evidence });
}

async function readJson(route) {
  const startedAt = performance.now();
  const response = await fetch(new URL(route, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  routeTimings.push({ route, durationMs: Math.round(performance.now() - startedAt), status: response.status });
  if (!response.ok) throw new Error(`${route} returned ${response.status}.`);
  return response.json();
}

async function readText(route) {
  const startedAt = performance.now();
  const response = await fetch(new URL(route, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  routeTimings.push({ route, durationMs: Math.round(performance.now() - startedAt), status: response.status });
  if (!response.ok) throw new Error(`${route} returned ${response.status}.`);
  return response.text();
}

async function probeResponsiveLayout(url) {
  const chrome = await findChrome();
  const profile = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "agentflow-live-layout-"));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const browserWs = await new Promise((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome DevTools endpoint did not become ready.")), 10_000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Chrome exited before layout verification (${code}).`)); });
    });
    const debugBase = new URL(browserWs.replace(/^ws/u, "http"));
    const targets = await (await fetch(new URL("/json/list", debugBase))).json();
    const target = targets.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page target.");
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      const results = [];
      for (const width of [1280, 390]) {
        await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        const loaded = cdp.wait("Page.loadEventFired", 10_000);
        await cdp.call("Page.navigate", { url });
        await loaded;
        const evaluated = await cdp.call("Runtime.evaluate", { expression: `({width:${width},clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1})`, returnByValue: true });
        results.push(evaluated.result.value);
      }
      return results;
    } finally { cdp.close(); }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await fs.rm(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 2) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
}

async function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ];
  for (const candidate of candidates) if (await fs.stat(candidate).then(() => true, () => false)) return candidate;
  throw new Error("A local Chrome or Chromium binary is required for responsive live verification.");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  let serial = 0;
  const pending = new Map();
  const events = new Map();
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); return; }
    const waiter = events.get(message.method); if (waiter) { events.delete(message.method); waiter.resolve(message.params); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await call("Page.enable"); await call("Runtime.enable");
  return {
    call,
    wait(method, timeoutMs) { return new Promise((resolve, reject) => { const timeout = setTimeout(() => { events.delete(method); reject(new Error(`${method} timed out.`)); }, timeoutMs); events.set(method, { resolve: (value) => { clearTimeout(timeout); resolve(value); } }); }); },
    close() { socket.close(); }
  };
}
