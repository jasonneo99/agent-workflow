#!/usr/bin/env node
/**
 * evaluation-daemon: periodically run Agent Workflow evaluation suites.
 *
 * One launchd tick = one run of `tick()`. The tick:
 *   1. Loads `.agent-workflow/evaluation-daemon.yaml` (writes defaults if missing).
 *   2. Skips entirely if a lockfile shows a run already in progress (stale locks are reaped).
 *   3. Finds suite YAMLs in `.agent-workflow/evaluations/` whose newest result
 *      is older than the configured interval (or that never ran).
 *   4. Runs each due suite via the existing `evaluate` CLI (subprocess, capped
 *      at max_concurrent in flight), records results to the evaluations dir.
 *   5. Appends per-evaluation cost info to a JSONL log; on failure notifies
 *      via `scripts/notify-requester.py`.
 *
 * Usage: node scripts/evaluation-daemon.ts --tick [--config <path>] [--repo <dir>]
 */
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { evaluationSuiteSchema } from "../packages/evaluation/src/index.js";

const execFileAsync = promisify(execFile);

export interface DaemonConfig {
  interval_hours: number;
  suite_glob: string;
  max_concurrent: number;
  project: string;
  hour: number;
  minute: number;
  timeout_minutes: number;
  skip_index: boolean;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  interval_hours: 24,
  suite_glob: "*.yaml",
  max_concurrent: 1,
  project: ".",
  hour: 2,
  minute: 0,
  timeout_minutes: 180,
  skip_index: true,
};

export interface SuiteInfo {
  name: string; // basename without .yaml
  path: string; // absolute suite path
}

/** Report identity comes from YAML, never from the filename. */
export async function resolveSuiteIdentities(suites: SuiteInfo[]): Promise<SuiteInfo[]> {
  const seen = new Set<string>();
  const resolved: SuiteInfo[] = [];
  for (const suite of suites) {
    const parsed = evaluationSuiteSchema.parse(YAML.parse(await fs.readFile(suite.path, "utf8")));
    const id: unknown = parsed?.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
      throw new Error(`Invalid evaluation suite id in ${path.basename(suite.path)}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate evaluation suite id: ${id}`);
    seen.add(id);
    resolved.push({ ...suite, name: id });
  }
  return resolved;
}

export interface ResultFile {
  name: string;
  mtimeMs: number;
}

export interface SuiteOutcome {
  skipped?: boolean;
  suite: string;
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  resultJson: string | null;
  costSummary: unknown;
  error?: string;
}

/** Minimal glob: supports `*` wildcards only. */
export function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

export function isResultFile(name: string): boolean {
  return /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.(json|md)$/.test(name);
}

export function isSuiteFile(name: string, suiteGlob: string): boolean {
  return name.endsWith(".yaml") && globMatch(suiteGlob, name) && !isResultFile(name);
}

export function listSuites(evalsDir: string, suiteGlob: string, entries: string[]): SuiteInfo[] {
  return entries
    .filter((e) => isSuiteFile(e, suiteGlob))
    .map((e) => ({ name: e.slice(0, -".yaml".length), path: path.join(evalsDir, e) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A suite is due when it has no result file (`<name>-<timestamp>.json`)
 * or its newest result is older than intervalMs.
 */
export function findDueSuites(
  suites: SuiteInfo[],
  results: ResultFile[],
  intervalMs: number,
  nowMs: number,
): SuiteInfo[] {
  return suites.filter((suite) => {
    const prefix = `${suite.name}-`;
    let newest = -1;
    for (const r of results) {
      if (r.name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/.test(r.name.slice(prefix.length)) && r.mtimeMs > newest) {
        newest = r.mtimeMs;
      }
    }
    return newest < 0 || nowMs - newest >= intervalMs;
  });
}

export interface LockInfo {
  pid: number;
  startedAt: string;
}

/** True when the lockfile names a process that is no longer alive. */
export function lockIsStale(lock: LockInfo): boolean {
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function readLock(lockPath: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "") };
  } catch {
    return null;
  }
}

/** Run items with at most `limit` in flight. Resolves when all complete. */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, Math.floor(limit));
  let next = 0;
  const workers = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function loadConfig(configPath: string): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
    return { ...DEFAULT_CONFIG };
  }
  const parsed: unknown = YAML.parse(raw) ?? {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid evaluation daemon configuration");
  const config = { ...DEFAULT_CONFIG, ...parsed } as DaemonConfig;
  for (const key of ["interval_hours", "timeout_minutes"] as const) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(config.max_concurrent) || config.max_concurrent < 1) throw new Error("Invalid max_concurrent");
  if (!Number.isInteger(config.hour) || config.hour < 0 || config.hour > 23) throw new Error("Invalid hour");
  if (!Number.isInteger(config.minute) || config.minute < 0 || config.minute > 59) throw new Error("Invalid minute");
  if (typeof config.suite_glob !== "string" || !config.suite_glob) throw new Error("Invalid suite_glob");
  if (typeof config.project !== "string" || !config.project) throw new Error("Invalid project");
  if (typeof config.skip_index !== "boolean") throw new Error("Invalid skip_index");
  return config;
}

function newestResultJson(evalsDir: string, suiteName: string, entries: string[]): string | null {
  const prefix = `${suiteName}-`;
  const match = entries
    .filter((e) => e.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/.test(e.slice(prefix.length)))
    .sort()
    .pop();
  return match ? path.join(evalsDir, match) : null;
}

async function extractCostSummary(resultJson: string | null): Promise<unknown> {
  if (!resultJson) return null;
  try {
    const data = JSON.parse(await fs.readFile(resultJson, "utf8")) as {
      rows?: Array<{ estimatedCostMix?: unknown }>;
    };
    const mixes = (data.rows ?? []).map((r) => r.estimatedCostMix).filter(Boolean);
    return { rows: data.rows?.length ?? 0, estimatedCostMix: mixes };
  } catch {
    return null;
  }
}

export interface TickDeps {
  repoRoot: string;
  evalsDir: string;
  configPath: string;
  lockPath: string;
  statePath: string;
  tokenLogPath: string;
  notifyScript: string;
  nowMs?: number;
  spawnProcess?: typeof spawn;
}

export interface TickResult {
  skipped: boolean;
  skipReason?: string;
  due: string[];
  outcomes: SuiteOutcome[];
}

export async function notifyFailure(deps: TickDeps, suite: string, detail: string): Promise<void> {
  const payload = {
    notificationId: `eval-daemon-${Date.now()}`,
    runId: "evaluation-daemon",
    kind: "evaluation-failed",
    title: `Evaluation failed: ${suite}`,
    body: detail.slice(0, 1000),
  };
  try {
    const child = (deps.spawnProcess ?? spawn)("python3", [deps.notifyScript], { stdio: ["pipe", "ignore", "ignore"] });
    await new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("close", () => resolve());
      child.stdin?.once("error", () => resolve());
      child.stdin?.end(JSON.stringify(payload));
    });
  } catch {
    // Notification is best-effort; the failure is already logged.
  }
}

async function runSuite(
  deps: TickDeps,
  config: DaemonConfig,
  suite: SuiteInfo,
): Promise<SuiteOutcome> {
  const started = Date.now();
  const outDir = deps.evalsDir;
  const previousReports = new Set(await fs.readdir(outDir).catch(() => [] as string[]));
  const args = [
    path.join(deps.repoRoot, "dist", "apps", "cli", "src", "index.js"),
    "evaluate",
    "-s",
    suite.path,
    "-p",
    path.resolve(deps.repoRoot, config.project),
    "-o",
    outDir,
  ];
  if (config.skip_index) args.push("--skip-index");
  const outcome: SuiteOutcome = {
    suite: suite.name,
    ok: false,
    durationMs: 0,
    exitCode: null,
    resultJson: null,
    costSummary: null,
  };
  try {
    const proc = (deps.spawnProcess ?? spawn)(process.execPath, args, { cwd: deps.repoRoot, stdio: "ignore" });
    const timeoutMs = config.timeout_minutes * 60 * 1000;
    const exitCode: number | null = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(null);
      }, timeoutMs);
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    outcome.exitCode = exitCode;
    outcome.skipped = exitCode === 75;
    outcome.ok = exitCode === 0;
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
  }
  outcome.durationMs = Date.now() - started;
  try {
    const entries = await fs.readdir(deps.evalsDir);
    outcome.resultJson = outcome.skipped ? null : newestResultJson(deps.evalsDir, suite.name, entries.filter((entry) => !previousReports.has(entry)));
    outcome.costSummary = await extractCostSummary(outcome.resultJson);
  } catch {
    // best-effort
  }
  return outcome;
}

async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

/** Execute one daemon tick. Returns what happened. */
export async function tick(deps: TickDeps): Promise<TickResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const config = await loadConfig(deps.configPath);

  await fs.mkdir(path.dirname(deps.lockPath), { recursive: true });
  const acquisitionPath = `${deps.lockPath}.acquiring`;
  try {
    await fs.mkdir(acquisitionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { skipped: true, skipReason: "lock acquisition in progress; inspect orphaned acquisition directory if persistent", due: [], outcomes: [] };
    }
    throw error;
  }
  try {
    const existingLock = await readLock(deps.lockPath);
    if (existingLock && !lockIsStale(existingLock)) {
      return { skipped: true, skipReason: `lock held by pid ${existingLock.pid}`, due: [], outcomes: [] };
    }
    if (existingLock) await fs.unlink(deps.lockPath);
    await fs.writeFile(
      deps.lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date(nowMs).toISOString() }),
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { skipped: true, skipReason: "lock already exists", due: [], outcomes: [] };
    }
    throw error;
  } finally {
    await fs.rmdir(acquisitionPath);
  }

  const result: TickResult = { skipped: false, due: [], outcomes: [] };
  try {
    const entries = await fs.readdir(deps.evalsDir);
    const suites = await resolveSuiteIdentities(listSuites(deps.evalsDir, config.suite_glob, entries));
    const results: ResultFile[] = [];
    for (const e of entries) {
      if (e.endsWith(".json") || e.endsWith(".md")) {
        try {
          const st = await fs.stat(path.join(deps.evalsDir, e));
          results.push({ name: e, mtimeMs: st.mtimeMs });
        } catch {
          // ignore disappearing files
        }
      }
    }
    const due = findDueSuites(suites, results, config.interval_hours * 3600 * 1000, nowMs);
    result.due = due.map((s) => s.name);

    await runWithConcurrency(due, config.max_concurrent, async (suite) => {
      const outcome = await runSuite(deps, config, suite);
      result.outcomes.push(outcome);
      await appendJsonl(deps.tokenLogPath, {
        ts: new Date().toISOString(),
        suite: outcome.suite,
        ok: outcome.ok,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        costSummary: outcome.costSummary,
        tokenUsage: {
          status: "unknown",
          totalTokens: null,
          reason: "The existing evaluation report does not expose measured token usage",
        },
        error: outcome.error ?? null,
      });
      if (!outcome.ok && !outcome.skipped) {
        await notifyFailure(
          deps,
          suite.name,
          `exitCode=${outcome.exitCode} durationMs=${outcome.durationMs} ${outcome.error ?? ""}`.trim(),
        );
      }
    });

    await fs.writeFile(
      deps.statePath,
      JSON.stringify(
        {
          lastTick: new Date(nowMs).toISOString(),
          due: result.due,
          outcomes: result.outcomes.map((o) => ({
            suite: o.suite,
            ok: o.ok,
            skipped: o.skipped ?? false,
            exitCode: o.exitCode,
            durationMs: o.durationMs,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
  } finally {
    try {
      await fs.unlink(deps.lockPath);
    } catch {
      // lock already gone
    }
  }
  return result;
}

function parseArgs(argv: string[]): { tick: boolean; config?: string; repo?: string } {
  const out: { tick: boolean; config?: string; repo?: string } = { tick: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tick") out.tick = true;
    else if (argv[i] === "--config") out.config = argv[++i];
    else if (argv[i] === "--repo") out.repo = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tick) {
    console.error("Usage: evaluation-daemon.ts --tick [--config <path>] [--repo <dir>]");
    process.exitCode = 2;
    return;
  }
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = args.repo ?? (path.basename(scriptRoot) === "dist" ? path.dirname(scriptRoot) : scriptRoot);
  const agentflowDir = path.join(repoRoot, ".agent-workflow");
  const deps: TickDeps = {
    repoRoot,
    evalsDir: path.join(agentflowDir, "evaluations"),
    configPath: args.config ?? path.join(agentflowDir, "evaluation-daemon.yaml"),
    lockPath: path.join(agentflowDir, "evaluation-daemon.lock"),
    statePath: path.join(agentflowDir, "evaluation-daemon-state.json"),
    tokenLogPath: path.join(agentflowDir, "evaluation-daemon-tokens.jsonl"),
    notifyScript: path.join(repoRoot, "scripts", "notify-requester.py"),
  };
  const result = await tick(deps);
  console.log(JSON.stringify(result, null, 2));
  const failed = result.outcomes.filter((o) => !o.ok && !o.skipped).length;
  if (failed > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
