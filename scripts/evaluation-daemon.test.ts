import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  globMatch,
  isResultFile,
  isSuiteFile,
  listSuites,
  findDueSuites,
  lockIsStale,
  runWithConcurrency,
  tick,
  type TickDeps,
  type ResultFile,
} from "./evaluation-daemon.js";

const HOUR = 3600 * 1000;

describe("suite/result file classification", () => {
  it("recognizes timestamped result files", () => {
    assert.equal(isResultFile("foo-2026-09-29T21-40-36Z.json"), true);
    assert.equal(isResultFile("foo-2026-09-29T21-40-36Z.md"), true);
    assert.equal(isResultFile("foo.yaml"), false);
    assert.equal(isResultFile("foo.json"), false);
  });

  it("treats suite yamls as suites but never result files", () => {
    assert.equal(isSuiteFile("daemon-model-comparison-fast.yaml", "*.yaml"), true);
    assert.equal(isSuiteFile("daemon-model-comparison-fast-2026-09-29T21-40-36Z.json", "*.yaml"), false);
  });

  it("honors the suite glob filter", () => {
    assert.equal(isSuiteFile("nightly-smoke.yaml", "nightly-*.yaml"), true);
    assert.equal(isSuiteFile("weekly-full.yaml", "nightly-*.yaml"), false);
  });

  it("globMatch supports * wildcards", () => {
    assert.equal(globMatch("*.yaml", "a.yaml"), true);
    assert.equal(globMatch("nightly-*.yaml", "nightly-x.yaml"), true);
    assert.equal(globMatch("nightly-*.yaml", "weekly-x.yaml"), false);
  });
});

describe("findDueSuites", () => {
  const now = Date.now();
  const suites = [
    { name: "never-ran", path: "/evals/never-ran.yaml" },
    { name: "recent", path: "/evals/recent.yaml" },
    { name: "stale", path: "/evals/stale.yaml" },
    { name: "recent-extended", path: "/evals/recent-extended.yaml" },
  ];
  const results: ResultFile[] = [
    { name: "recent-2026-09-29T21-40-36Z.json", mtimeMs: now - 1 * HOUR },
    { name: "recent-2026-09-29T21-40-36Z.md", mtimeMs: now - 1 * HOUR },
    { name: "stale-2026-09-01T00-00-00Z.json", mtimeMs: now - 48 * HOUR },
    // prefix trap: must not count for "recent"
    { name: "recent-extended-2026-09-29T21-40-36Z.json", mtimeMs: now - 1 * HOUR },
  ];

  it("marks never-run suites due", () => {
    const due = findDueSuites(suites, results, 24 * HOUR, now);
    assert.ok(due.some((s) => s.name === "never-ran"));
  });

  it("marks suites with only stale results due", () => {
    const due = findDueSuites(suites, results, 24 * HOUR, now);
    assert.ok(due.some((s) => s.name === "stale"));
  });

  it("does not mark suites with a fresh result due", () => {
    const due = findDueSuites(suites, results, 24 * HOUR, now);
    assert.ok(!due.some((s) => s.name === "recent"));
  });

  it("does not confuse name prefixes (recent vs recent-extended)", () => {
    // recent-extended has a fresh result of its own; strip it and it must become due
    const withoutOwn = results.filter((r) => !r.name.startsWith("recent-extended-"));
    const due = findDueSuites(suites, withoutOwn, 24 * HOUR, now);
    assert.ok(due.some((s) => s.name === "recent-extended"));
    assert.ok(!due.some((s) => s.name === "recent"));
  });

  it("uses the newest result when several exist", () => {
    const multi: ResultFile[] = [
      { name: "stale-2026-08-01T00-00-00Z.json", mtimeMs: now - 200 * HOUR },
      { name: "stale-2026-09-29T21-40-36Z.json", mtimeMs: now - 1 * HOUR },
    ];
    const due = findDueSuites([{ name: "stale", path: "/evals/stale.yaml" }], multi, 24 * HOUR, now);
    assert.equal(due.length, 0);
  });
});

describe("lock staleness", () => {
  it("treats the current process pid as live", () => {
    assert.equal(lockIsStale({ pid: process.pid, startedAt: new Date().toISOString() }), false);
  });

  it("treats a bogus pid as stale", () => {
    assert.equal(lockIsStale({ pid: 999999999, startedAt: new Date().toISOString() }), true);
  });
});

describe("runWithConcurrency", () => {
  it("caps in-flight work and processes every item", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      inFlight--;
    });
    assert.equal(maxInFlight, 2);
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
  });

  it("handles a limit larger than the item count", async () => {
    let count = 0;
    await runWithConcurrency(["a"], 10, async () => {
      count++;
    });
    assert.equal(count, 1);
  });
});

describe("tick guardrails", () => {
  let tmp: string;
  let deps: TickDeps;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eval-daemon-test-"));
    const agentflowDir = path.join(tmp, ".agent-workflow");
    await fs.mkdir(path.join(agentflowDir, "evaluations"), { recursive: true });
    deps = {
      repoRoot: tmp,
      evalsDir: path.join(agentflowDir, "evaluations"),
      configPath: path.join(agentflowDir, "evaluation-daemon.yaml"),
      lockPath: path.join(agentflowDir, "evaluation-daemon.lock"),
      statePath: path.join(agentflowDir, "evaluation-daemon-state.json"),
      tokenLogPath: path.join(agentflowDir, "evaluation-daemon-tokens.jsonl"),
      notifyScript: path.join(tmp, "scripts", "notify-requester.py"),
      nowMs: Date.now(),
    };
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("skips the tick when the lock is held by a live process", async () => {
    await fs.writeFile(
      deps.lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );
    const result = await tick(deps);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /lock held by pid/);
    assert.deepEqual(result.outcomes, []);
  });

  it("proceeds past a stale lock and cleans it up", async () => {
    await fs.writeFile(
      deps.lockPath,
      JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }),
      "utf8",
    );
    const result = await tick(deps);
    assert.equal(result.skipped, false);
    // no suites in the dir -> nothing due, lock released
    assert.deepEqual(result.due, []);
    const lockStillThere = await fs
      .stat(deps.lockPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(lockStillThere, false);
  });

  it("writes a default config when none exists", async () => {
    const result = await tick(deps);
    assert.equal(result.skipped, false);
    const raw = await fs.readFile(deps.configPath, "utf8");
    assert.match(raw, /interval_hours:\s*24/);
    assert.match(raw, /max_concurrent:\s*1/);
  });

  it("detects a due suite end-to-end from the evaluations dir", async () => {
    await fs.writeFile(path.join(deps.evalsDir, "smoke.yaml"), "id: smoke\n", "utf8");
    await fs.writeFile(
      path.join(deps.evalsDir, "smoke-2026-01-01T00-00-00Z.json"),
      "{}\n",
      "utf8",
    );
    // backdate the result file so it counts as stale
    const old = new Date("2026-01-02T00:00:00Z");
    await fs.utimes(path.join(deps.evalsDir, "smoke-2026-01-01T00-00-00Z.json"), old, old);
    const { listSuites: ls, findDueSuites: fds } = await import("./evaluation-daemon.js");
    const entries = await fs.readdir(deps.evalsDir);
    const suites = ls(deps.evalsDir, "*.yaml", entries);
    assert.equal(suites.length, 1);
    const due = fds(
      suites,
      [{ name: "smoke-2026-01-01T00-00-00Z.json", mtimeMs: old.getTime() }],
      24 * HOUR,
      Date.now(),
    );
    assert.equal(due.length, 1);
    assert.equal(due[0].name, "smoke");
  });
});
