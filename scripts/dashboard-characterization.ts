/** Dashboard characterization harness.
 *
 * Seeds a throwaway database and throwaway projects with the mock provider,
 * starts a dashboard from --root on a free port, requests every GET route
 * (plus seeded-run and seeded-project variants), normalizes each response and
 * records or compares status, content type and a hash of the normalized body.
 *
 *   npm run dashboard:characterize -- --record                # on the code to preserve
 *   npm run dashboard:characterize -- --check --calibrate     # same code: mark noisy bodies
 *   npm run dashboard:characterize -- --check                 # after each change
 *
 * The dashboard and CLI always run from a throwaway git worktree holding a
 * copy of --root's working tree (tracked and untracked, non-ignored files),
 * so their runtime caches, ledgers and receipts never land in a real checkout.
 *
 * The baseline and normalized bodies stay under .agent-workflow/reports/
 * (gitignored): they describe this machine, not the framework. Only the exact
 * UUID-named database created by an invocation is ever dropped.
 */
import "./test-environment.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { migrateStorage } from "../packages/storage/src/postgres.js";
import {
  type CharacterizationRoute, type CharacterizationSample,
  compareSamples, extractDashboardRoutes, hashNormalized, normalizeResponse, sampleKey,
} from "../apps/cli/src/dashboard/characterization.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const mode = args.includes("--record") ? "record" : args.includes("--check") ? "check" : null;
if (!mode) throw new Error("Pass --record or --check.");
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sourceRoot = path.resolve(option("--root") ?? repoRoot);
const outDir = path.resolve(option("--out") ?? path.join(repoRoot, ".agent-workflow", "reports", "dashboard-characterization"));
const baselinePath = path.join(outDir, "baseline.json");
const bodiesDir = path.join(outDir, mode === "record" ? "baseline-bodies" : "current-bodies");

const configured = databaseUrl();
const dbName = `agentflow_characterize_${randomUUID().replaceAll("-", "")}`;
assert.match(dbName, /^agentflow_characterize_[a-f0-9]{32}$/u);
const target = new URL(configured); target.pathname = `/${dbName}`;
const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 5000 });
const work = await mkdtemp(path.join(os.tmpdir(), "agentflow-characterize-"));
const codeRoot = path.join(work, "code");
let worktreeAdded = false;
let dashboard: ChildProcess | undefined;
let fixture: pg.Client | undefined;
let created = false;

const childEnv = () => ({ ...process.env, DATABASE_URL: target.href, TEST_DATABASE_URL: target.href, DEFAULT_MODEL_PROVIDER: "mock", AGENTFLOW_MODEL_POLICY: "", AGENTFLOW_LEARNING_DAEMON: "0" });
const cli = (cliArgs: string[], timeoutMs = 180_000, allowedExit = [0]) => new Promise<string>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...cliArgs], { cwd: codeRoot, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.once("error", reject);
  child.once("exit", code => { clearTimeout(timer); allowedExit.includes(code ?? -1) ? resolve(output) : reject(new Error(`agentflow ${cliArgs.join(" ")} exited ${code}:\n${output.slice(-1500)}`)); });
});
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
});
const RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const runIdFrom = (output: string) => output.match(new RegExp(`^Run: (${RUN_ID})`, "mu"))?.[1] ?? output.match(new RegExp(`workflow run (${RUN_ID})`, "iu"))?.[1];

async function makeProject(name: string): Promise<string> {
  const dir = path.join(work, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node -e 0" } }));
  const git = (gitArgs: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn("git", gitArgs, { cwd: dir, stdio: "ignore" });
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`git ${gitArgs[0]} failed`)));
  });
  await git(["init", "-q"]); await git(["add", "."]);
  await git(["-c", "user.email=dev@example.com", "-c", "user.name=Example", "commit", "-qm", "init"]);
  await cli(["init-project", "--project", dir, "--profile", "enterprise"]);
  return dir;
}

const run = (command: string, commandArgs: string[], cwd: string) => new Promise<string>((resolve, reject) => {
  const child = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`${command} ${commandArgs.join(" ")} failed:\n${output.slice(-800)}`)));
});

/** Copy sourceRoot's working tree into a detached throwaway worktree. */
async function isolateCode(): Promise<void> {
  await run("git", ["worktree", "add", "-q", "--detach", codeRoot, "HEAD"], sourceRoot);
  worktreeAdded = true;
  const files = (await run("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], sourceRoot)).split("\0").filter(Boolean);
  const deleted = new Set((await run("git", ["ls-files", "-z", "-d"], sourceRoot)).split("\0").filter(Boolean));
  for (const file of files) {
    if (deleted.has(file)) { await rm(path.join(codeRoot, file), { force: true }); continue; }
    await mkdir(path.dirname(path.join(codeRoot, file)), { recursive: true });
    await copyFile(path.join(sourceRoot, file), path.join(codeRoot, file));
  }
  await symlink(path.join(sourceRoot, "node_modules"), path.join(codeRoot, "node_modules"));
}

try {
  await isolateCode();
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE template0`);
  created = true;
  fixture = new pg.Client({ connectionString: target.href });
  fixture.on("error", () => undefined);
  await fixture.connect();
  await fixture.query(await readFile(path.join(repoRoot, "infra", "init.sql"), "utf8"));
  process.env.DATABASE_URL = target.href;
  await migrateStorage();
  await cli(["bootstrap-storage"]);

  const billing = await makeProject("billing-api");
  const portal = await makeProject("web-portal");
  const completed = runIdFrom(await cli(["run-and-watch", "answer-question", "--project", billing, "--task", "Which services does billing call when an invoice is finalized?"], 300_000));
  const blocked = runIdFrom(await cli(["run-and-watch", "build-feature", "--project", portal, "--task", "Add a dark mode toggle to account settings"], 300_000, [0, 2]));
  const queued = runIdFrom(await cli(["run", "answer-question", "--project", portal, "--task", "Where is the session timeout configured?"]));
  const failed = runIdFrom(await cli(["run", "review-pr", "--project", billing, "--task", "Review the retry change in the payment client"]));
  await cli(["request-approval", "--project", billing, "--type", "deployment", "--target", "staging", "--rationale", "Ship the payment retry change to staging"]);
  assert.ok(completed && blocked && queued && failed, "every seeded run reported its id");
  await fixture.query(`with t as (update workflow_tasks set status = case when id = (select id from workflow_tasks where run_id = $1 order by stage_id = 'inspect' desc, stage_id limit 1) then 'failed' else 'cancelled' end, attempts = 3 where run_id = $1 returning 1)
    update workflow_runs set status = 'failed', finished_at = now(), updated_at = now() where id = $1`, [failed]);
  await fixture.end(); fixture = undefined;

  const port = await freePort();
  dashboard = spawn(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", "dashboard", "--port", String(port)], { cwd: codeRoot, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let dashboardLog = "";
  dashboard.stdout?.on("data", chunk => { dashboardLog += chunk; });
  dashboard.stderr?.on("data", chunk => { dashboardLog += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try { if ((await fetch(`${base}/runs`)).ok) break; } catch { /* starting */ }
    if (attempt > 120) throw new Error(`Dashboard did not start:\n${dashboardLog.slice(-1500)}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const baseline = mode === "check" ? JSON.parse(await readFile(baselinePath, "utf8")) as { routes: CharacterizationRoute[]; samples: CharacterizationSample[] } : null;
  const routes = baseline?.routes ?? extractDashboardRoutes(await readFile(path.join(codeRoot, "apps", "cli", "src", "commands", "daemon.ts"), "utf8"));
  const runs = { completed, blocked, queued, failed } as Record<string, string>;
  const labels: Array<[string, string]> = [
    ...Object.entries(runs).map(([label, id]) => [id, `<run:${label}>`] as [string, string]),
    [work, "<work>"], [encodeURIComponent(work), "<work>"], [codeRoot, "<root>"], [encodeURIComponent(codeRoot), "<root>"], [dbName, "<database>"],
    [os.homedir(), "<home>"], [String(port), "<port>"],
  ];
  // The home page and the not-found page are guarded by a negative match, not a literal.
  const requests: Array<{ path: string; query: string }> = [{ path: "/", query: "" }, { path: "/no-such-page", query: "" }];
  for (const route of routes) {
    requests.push({ path: route.path, query: "" });
    const runParam = route.params.find(param => ["id", "run", "runId"].includes(param));
    if (runParam) for (const label of Object.keys(runs)) requests.push({ path: route.path, query: `${runParam}=<run:${label}>` });
    if (route.params.includes("project")) requests.push({ path: route.path, query: "project=<project:billing>" });
  }
  const resolveQuery = (query: string) => query
    .replace(/<run:(\w+)>/gu, (_, label: string) => runs[label]!)
    .replace("<project:billing>", encodeURIComponent(billing));

  await mkdir(bodiesDir, { recursive: true });
  const samples: CharacterizationSample[] = [];
  const queue = [...requests];
  const fetchSample = async (request: { path: string; query: string }) => {
    const url = `${base}${request.path}${request.query ? `?${resolveQuery(request.query)}` : ""}`;
    let response: Response | undefined, body = "";
    // Slow pages first send a loading page and fill in on reload; wait for the real one.
    const key = sampleKey(request.path, request.query);
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
        // Event streams never end; their status and type are the behavior.
        if ((response.headers.get("content-type") ?? "").startsWith("text/event-stream")) { await response.body?.cancel(); body = ""; break; }
        body = await response.text();
        if (!body.includes("data-dashboard-loading")) break;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
    } catch (error) {
      samples.push({ key, status: -1, contentType: `error: ${error instanceof Error ? error.message : String(error)}`, hash: "", bytes: 0 });
      return;
    }
    const normalized = normalizeResponse(body, { labels });
    await writeFile(path.join(bodiesDir, `${key.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 150)}.txt`), normalized);
    samples.push({ key, status: response!.status, contentType: (response!.headers.get("content-type") ?? "").split(";")[0]!, hash: hashNormalized(normalized), bytes: normalized.length });
  };
  await Promise.all(Array.from({ length: 4 }, async () => { for (let next = queue.shift(); next; next = queue.shift()) await fetchSample(next); }));
  samples.sort((a, b) => a.key.localeCompare(b.key));

  if (mode === "record") {
    await writeFile(baselinePath, `${JSON.stringify({ recordedAt: new Date().toISOString(), routes, samples }, null, 2)}\n`);
    console.log(`Recorded ${samples.length} responses across ${routes.length} routes to ${path.relative(repoRoot, baselinePath)}.`);
  } else {
    const changes = compareSamples(baseline!.samples, samples);
    if (args.includes("--calibrate")) {
      // Run against the same code that recorded the baseline: any body that
      // still differs is run-to-run noise, so compare only its status and type.
      const noisy = new Set(changes.filter(change => change.change.startsWith("body changed")).map(change => change.key));
      const structural = changes.filter(change => !noisy.has(change.key));
      for (const sample of baseline!.samples) if (noisy.has(sample.key)) sample.volatile = true;
      await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      for (const change of structural) console.log(`UNSTABLE ${change.key}: ${change.change}`);
      console.log(`Calibrated: ${noisy.size} volatile bodies; ${structural.length} unstable statuses or types.`);
      if (structural.length) process.exitCode = 1;
    } else {
      for (const change of changes) console.log(`CHANGED ${change.key}: ${change.change}`);
      console.log(changes.length ? `${changes.length} of ${baseline!.samples.length} responses changed.` : `All ${baseline!.samples.length} responses match the baseline.`);
      if (changes.length) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  dashboard?.kill("SIGTERM");
  await fixture?.end().catch(() => undefined);
  await admin.query(created ? `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)` : "select 1").catch(error => console.error(`Cleanup of ${dbName} failed: ${error}`));
  await admin.end().catch(() => undefined);
  if (worktreeAdded) await run("git", ["worktree", "remove", "--force", codeRoot], sourceRoot).catch(error => console.error(String(error)));
  await rm(work, { recursive: true, force: true });
}
