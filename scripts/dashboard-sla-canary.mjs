import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = new Map(process.argv.slice(2).map((value, index, values) => value.startsWith("--") ? [value, values[index + 1] && !values[index + 1].startsWith("--") ? values[index + 1] : "true"] : [value, value]));
const project = path.resolve(root, args.get("--project") ?? ".");
const port = Number(args.get("--port") ?? "17901");
const warmBudgetMs = Number(args.get("--warm-budget-ms") ?? "800");
const samples = Math.max(1, Number(args.get("--samples") ?? "3"));
const baseUrl = `http://127.0.0.1:${port}`;
const canaryId = `sla-${Date.now()}`;
const routes = [
  { name: "home", path: `/?canary=${canaryId}` },
  { name: "queue", path: `/queue?canary=${canaryId}` },
  { name: "runs", path: `/runs?canary=${canaryId}` },
  { name: "activity", path: `/activity?canary=${canaryId}` },
  { name: "approvals", path: `/approvals?canary=${canaryId}` },
  { name: "approval-rules", path: `/approval-rules?canary=${canaryId}` },
  { name: "projects", path: `/projects?canary=${canaryId}` },
  { name: "learning", path: `/learning?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "training-proposals", path: `/training-proposals?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "evaluations", path: `/evaluations?canary=${canaryId}` },
  { name: "feedback-inbox", path: `/feedback-inbox?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "model-improvement", path: `/model-improvement?project=${encodeURIComponent(project)}&limit=50&canary=${canaryId}` },
  { name: "candidate-comparisons", path: `/candidate-comparisons?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "roadmap", path: `/roadmap?canary=${canaryId}` },
  { name: "providers", path: `/providers?canary=${canaryId}` },
  { name: "model-catalog", path: `/model-catalog?canary=${canaryId}` },
  { name: "settings", path: `/settings?canary=${canaryId}` },
  { name: "roles", path: `/roles?canary=${canaryId}` },
  { name: "governance", path: `/governance?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "bundles", path: `/bundles?canary=${canaryId}` },
  { name: "artifact-lifecycle", path: `/artifact-lifecycle?canary=${canaryId}` },
  { name: "context-gateway", path: `/context-gateway?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "studio", path: `/studio?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "workflow-graph", path: `/workflow-graph?project=${encodeURIComponent(project)}&canary=${canaryId}` },
  { name: "server-readiness", path: `/server-readiness?canary=${canaryId}` }
];

async function waitForDashboard(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited before readiness (code ${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/api/info`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Dashboard did not become ready within 10 seconds.");
}

async function startDashboard() {
  const child = spawn("npm", ["--silent", "run", "agentflow", "--", "dashboard", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  try {
    await waitForDashboard(child);
    return child;
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`);
  }
}

async function stopDashboard(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function measure(route) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${route.path}`, { signal: AbortSignal.timeout(30_000) });
  await response.arrayBuffer();
  return { route: route.name, status: response.status, durationMs: Math.round((performance.now() - started) * 10) / 10 };
}

function summarize(measurements) {
  return routes.map((route) => {
    const selected = measurements.filter((item) => item.route === route.name);
    const durations = selected.map((item) => item.durationMs).sort((left, right) => left - right);
    return { route: route.name, samples: selected.length, status: selected.every((item) => item.status === 200) ? 200 : selected.find((item) => item.status !== 200)?.status ?? 0, medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), maxMs: durations.at(-1) ?? null };
  });
}

function percentile(values, quantile) {
  return values.length ? values[Math.max(0, Math.ceil(values.length * quantile) - 1)] : null;
}

let child;
try {
  child = await startDashboard();
  const cold = [];
  for (const route of routes) cold.push(await measure(route));
  await stopDashboard(child);
  child = await startDashboard();
  const persistedWarmMeasurements = [];
  for (let sample = 0; sample < samples; sample += 1) for (const route of routes) persistedWarmMeasurements.push(await measure(route));
  const persistedWarm = summarize(persistedWarmMeasurements);
  const failures = persistedWarm.filter((item) => item.status !== 200 || (item.p95Ms ?? Infinity) > warmBudgetMs);
  const report = {
    kind: "agentflow_dashboard_sla_canary",
    generatedAt: new Date().toISOString(),
    budgets: { persistedWarmP95Ms: warmBudgetMs },
    routeCount: routes.length,
    samplesPerRoute: samples,
    cold,
    persistedWarm,
    status: failures.length ? "fail" : "pass",
    failures: failures.map((item) => `${item.route}: status=${item.status} p95Ms=${item.p95Ms}`)
  };
  const reportPath = path.join(project, ".agent-workflow", "runtime", "dashboard-sla", "latest.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (child) await stopDashboard(child);
}
