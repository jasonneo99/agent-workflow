import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { Command } from "commander";
import { registerEvaluationDaemonCommands } from "./evaluation-daemon.js";
import type { CliContext } from "../lib/context.js";
import { loadConfig, tick, type TickDeps } from "../../../../scripts/evaluation-daemon.js";

const suiteYaml = (id: string) => JSON.stringify({id, name:id, workflow:"build-feature", cases:[{id:"case",task:"Synthetic test"}], variants:[{id:"mock",provider:"mock",model_tier:"fast"}]});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evaluation-lifecycle-"));
  const dir = path.join(root, ".agent-workflow");
  await fs.mkdir(path.join(dir, "evaluations"), { recursive: true });
  const deps: TickDeps = {
    repoRoot: root, evalsDir: path.join(dir, "evaluations"),
    configPath: path.join(dir, "evaluation-daemon.yaml"),
    lockPath: path.join(dir, "evaluation-daemon.lock"),
    statePath: path.join(dir, "evaluation-daemon-state.json"),
    tokenLogPath: path.join(dir, "evaluation-daemon-tokens.jsonl"),
    notifyScript: path.join(root, "notify-requester.py"), nowMs: Date.UTC(2026, 0, 2),
  };
  return { root, dir, deps };
}

test("isolated Commander start/status/stop lifecycle never invokes live launchctl", async (t) => {
  const { root, dir } = await fixture();
  const calls: string[][] = [];
  const logs: string[] = [];
  t.mock.method(console, "log", (value: unknown) => logs.push(String(value)));
  const execute = async (file: string, args: string[]) => {
    assert.equal(file, "launchctl");
    calls.push(args);
    return {};
  };
  const command = async (...args: string[]) => {
    const program = new Command();
    registerEvaluationDaemonCommands(program, { rootDir: root } as CliContext, { homeDir: root, execute });
    await program.parseAsync(["node", "fixture", "evaluation-daemon", ...args]);
  };
  try {
    await fs.writeFile(path.join(dir, "evaluation-daemon.yaml"), "hour: 3\nminute: 15\ninterval_hours: 12\nmax_concurrent: 2\n");
    await command("start");
    const dest = path.join(root, "Library", "LaunchAgents", "com.agent-workflow.evaluation-daemon.plist");
    const xml = await fs.readFile(dest, "utf8");
    assert.match(xml, /<key>StartInterval<\/key><integer>43200<\/integer>/);
    assert.doesNotMatch(xml, /StartCalendarInterval/);
    assert.match(xml, /<string>--tick<\/string>/);
    assert.ok(xml.includes(root));
    await command("status", "--json");
    const status = JSON.parse(logs.at(-1)!);
    assert.equal(status.plistInstalled, true);
    assert.equal(status.loaded, true);
    assert.equal(status.intervalHours, 12);
    assert.equal(status.maxConcurrent, 2);
    assert.equal(status.runningNow, false);
    assert.equal(status.nextRun, null);
    assert.equal(status.schedule, "every 12 hours");
    await command("stop");
    await assert.rejects(fs.stat(dest), { code: "ENOENT" });
    assert.deepEqual(calls.map(args => args[0]), ["unload", "load", "list", "unload"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("launchd preserves daily defaults and supports fractional-hour cadence", async () => {
  const { root, dir } = await fixture();
  const command = async () => {
    const program = new Command();
    registerEvaluationDaemonCommands(program, { rootDir: root } as CliContext, { homeDir: root, execute: async () => ({}) });
    await program.parseAsync(["node", "fixture", "evaluation-daemon", "start"]);
    return fs.readFile(path.join(root, "Library", "LaunchAgents", "com.agent-workflow.evaluation-daemon.plist"), "utf8");
  };
  try {
    assert.match(await command(), /StartCalendarInterval/);
    await fs.writeFile(path.join(dir, "evaluation-daemon.yaml"), "interval_hours: 0.5\n");
    assert.match(await command(), /<key>StartInterval<\/key><integer>1800<\/integer>/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("isolated CLI propagates load failure and reports unavailable launchctl", async (t) => {
  const { root } = await fixture();
  const logs: string[] = [];
  t.mock.method(console, "log", (value: unknown) => logs.push(String(value)));
  const execute = async () => { throw new Error("synthetic launchctl failure"); };
  const command = async (...args: string[]) => {
    const program = new Command();
    registerEvaluationDaemonCommands(program, { rootDir: root } as CliContext, { homeDir: root, execute });
    await program.parseAsync(["node", "fixture", "evaluation-daemon", ...args]);
  };
  try {
    await assert.rejects(command("start"), /synthetic launchctl failure/);
    await command("status", "--json");
    assert.equal(JSON.parse(logs.at(-1)!).loaded, false);
    await command("stop");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("configuration accepts bounded overrides and rejects invalid input without overwriting it", async () => {
  const { root, deps } = await fixture();
  try {
    await fs.writeFile(deps.configPath, "interval_hours: 6\nmax_concurrent: 2\nsuite_glob: nightly-*.yaml\n");
    const valid = await loadConfig(deps.configPath);
    assert.equal(valid.interval_hours, 6);
    assert.equal(valid.max_concurrent, 2);
    assert.equal(valid.suite_glob, "nightly-*.yaml");
    for (const raw of ["max_concurrent: 0\n", "interval_hours: -1\n", "hour: 24\n", "minute: 60\n", "skip_index: nope\n", "[invalid]\n", "broken: [\n"]) {
      await fs.writeFile(deps.configPath, raw);
      await assert.rejects(loadConfig(deps.configPath));
      assert.equal(await fs.readFile(deps.configPath, "utf8"), raw);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("synthetic failed evaluation logs unknown tokens and uses notification bridge", async () => {
  const { root, deps } = await fixture();
  const invocations: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  deps.spawnProcess = ((file: string, args: string[]) => {
    invocations.push(file);
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill: () => boolean };
    child.stdin = new PassThrough();
    child.kill = () => true;
    if (file === "python3") {
      assert.deepEqual(args, [deps.notifyScript]);
      let raw = "";
      child.stdin.on("data", chunk => { raw += chunk.toString(); });
      child.stdin.on("finish", () => { payloads.push(JSON.parse(raw)); child.emit("close", 0); });
    } else {
      assert.equal(file, process.execPath);
      assert.ok(args.includes("evaluate"));
      assert.equal(args[args.indexOf("-o") + 1], deps.evalsDir);
      queueMicrotask(() => child.emit("close", 1));
    }
    return child;
  }) as unknown as typeof spawn;
  try {
    await fs.writeFile(path.join(deps.evalsDir, "synthetic.yaml"), suiteYaml("synthetic"));
    const result = await tick(deps);
    assert.equal(result.outcomes[0].ok, false);
    assert.deepEqual(invocations, [process.execPath, "python3"]);
    assert.equal(payloads[0].kind, "evaluation-failed");
    const log = JSON.parse((await fs.readFile(deps.tokenLogPath, "utf8")).trim());
    assert.equal(log.tokenUsage.status, "unknown");
    assert.equal(log.tokenUsage.totalTokens, null);
    assert.notEqual(log.tokenUsage.totalTokens, 0);
    await assert.rejects(fs.stat(deps.lockPath), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("busy evaluator is skipped without notification or stale report attribution", async () => {
  const { root, deps } = await fixture();
  deps.spawnProcess = ((file: string) => {
    assert.equal(file, process.execPath);
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 75));
    return child;
  }) as unknown as typeof spawn;
  try {
    await fs.writeFile(path.join(deps.evalsDir, "nightly.yaml"), suiteYaml("smoke"));
    const old = path.join(deps.evalsDir, "smoke-2026-01-01T00-00-00Z.json");
    await fs.writeFile(old, "{}");
    await fs.utimes(old, new Date(0), new Date(0));
    const result = await tick(deps);
    assert.deepEqual(result.due, ["smoke"]);
    assert.equal(result.outcomes[0].skipped, true);
    assert.equal(result.outcomes[0].ok, false);
    assert.equal(result.outcomes[0].resultJson, null);
    assert.equal(JSON.parse(await fs.readFile(deps.statePath, "utf8")).outcomes[0].skipped, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("synthetic successful ticks persist results, bound concurrency and exclude overlapping ticks", async () => {
  const { root, deps } = await fixture();
  let release!: () => void;
  let started!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let active = 0;
  let maximum = 0;
  let invocations = 0;
  deps.spawnProcess = ((file: string, args: string[]) => {
    assert.equal(file, process.execPath);
    assert.ok(args.includes("evaluate"));
    assert.equal(args[args.indexOf("-o") + 1], deps.evalsDir);
    const suite = path.basename(args[args.indexOf("-s") + 1], ".yaml");
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    invocations++;
    active++;
    maximum = Math.max(maximum, active);
    started();
    void (async () => {
      await hold;
      await fs.writeFile(path.join(deps.evalsDir, `${suite}-2026-01-02T00-00-00Z.json`), JSON.stringify({ rows: [{ estimatedCostMix: { synthetic: 1 } }] }));
      active--;
      child.emit("close", 0);
    })().catch(error => child.emit("error", error));
    return child;
  }) as unknown as typeof spawn;
  try {
    await fs.writeFile(deps.configPath, "max_concurrent: 2\nsuite_glob: nightly-*.yaml\n");
    for (const name of ["nightly-a", "nightly-b", "nightly-c", "excluded"]) {
      await fs.writeFile(path.join(deps.evalsDir, `${name}.yaml`), suiteYaml(name));
    }
    const running = tick(deps);
    await firstStarted;
    const overlapping = await tick(deps);
    assert.equal(overlapping.skipped, true);
    assert.deepEqual(overlapping.outcomes, []);
    release();
    const result = await running;
    assert.equal(maximum, 2);
    assert.equal(invocations, 3);
    assert.deepEqual(result.due, ["nightly-a", "nightly-b", "nightly-c"]);
    assert.equal(result.outcomes.length, 3);
    for (const outcome of result.outcomes) {
      assert.equal(outcome.ok, true);
      assert.ok(outcome.resultJson?.startsWith(deps.evalsDir + path.sep));
      assert.deepEqual(outcome.costSummary, { rows: 1, estimatedCostMix: [{ synthetic: 1 }] });
    }
    const state = JSON.parse(await fs.readFile(deps.statePath, "utf8"));
    assert.equal(state.outcomes.length, 3);
    await assert.rejects(fs.stat(deps.lockPath), { code: "ENOENT" });
  } finally { release(); await fs.rm(root, { recursive: true, force: true }); }
});
