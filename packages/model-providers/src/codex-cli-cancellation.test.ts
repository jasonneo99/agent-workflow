import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scenarios = ["abort-ignore", "timeout-ignore", "output-ignore", "term-exits-zero", "natural-exit", "held-pipe-after-exit", "output-exits-zero"];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function waitForPid(file: string): Promise<number> {
  for (let count = 0; count < 300; count++) {
    try {
      const pid = Number(await fs.readFile(file, "utf8"));
      assert.ok(Number.isSafeInteger(pid) && pid > 1); return pid;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("Owned fake CLI did not publish its PID within three seconds");
}

async function waitForAbsence(pid: number): Promise<void> {
  for (let count = 0; count < 200; count++) { if (!alive(pid)) return; await delay(10); }
  assert.fail("Owned fixture PID remains present: " + pid);
}

async function cleanupOwnedPid(file: string, script: string): Promise<void> {
  let pid: number;
  try { pid = Number(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  if (alive(pid)) {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    assert.ok(command.includes(script), "Never signal a reused or unrelated PID");
    process.kill(pid, "SIGKILL");
  }
  await waitForAbsence(pid);
}

test("actual Codex CLI processes have bounded cancellation without treating SIGTERM as exit", {
  skip: process.platform === "win32" ? "POSIX signal fixtures; native Windows escalation is not qualified here" : false
}, async t => {
  const scenario = process.env.AGENTFLOW_CODEX_CANCELLATION_CASE;
  if (!scenario) {
    for (const name of scenarios) await t.test(name, async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-cancel-test-")));
      const env: NodeJS.ProcessEnv = { AGENTFLOW_CODEX_CANCELLATION_CASE: name, AGENTFLOW_CODEX_CANCELLATION_ROOT: root };
      for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
      try {
        const child = spawnSync(process.execPath, ["--import", "tsx", "--test", fileURLToPath(import.meta.url)], {
          env, encoding: "utf8", timeout: name === "timeout-ignore" ? 12_000 : 8000, maxBuffer: 2 * 1024 * 1024
        });
        const output = child.stdout + child.stderr;
        const observation = output.split("\n").find(line => line.includes("CODEX_CANCELLATION_OBSERVATION"));
        if (observation) console.log(observation);
        assert.equal(child.status, 0, name + ": " + output.slice(-3000));
      } finally {
        await cleanupOwnedPid(path.join(root, "cli.pid"), path.join(root, "fake-codex.mjs"));
        await cleanupOwnedPid(path.join(root, "holder.pid"), path.join(root, "pipe-holder.mjs"));
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    return;
  }
  assert.ok(scenarios.includes(scenario));
  const root = process.env.AGENTFLOW_CODEX_CANCELLATION_ROOT!;
  assert.ok(root && path.isAbsolute(root));
  for (const directory of ["home", "codex-home", "tmp", "egress"]) await fs.mkdir(path.join(root, directory), { mode: 0o700 });
  const binary = path.join(root, "fake-codex.mjs"), holder = path.join(root, "pipe-holder.mjs");
  const pidFile = path.join(root, "cli.pid"), holderPidFile = path.join(root, "holder.pid"), signals = path.join(root, "signals");
  await fs.writeFile(holder, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(holderPidFile)},String(process.pid));setInterval(()=>{},1000);\n`);
  await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const mode=${JSON.stringify(scenario)},args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.160.0');process.exit(0);}
const finish=()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"summary":"synthetic complete"}');console.log('{"type":"turn.completed"}');process.exit(0);};
process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(signals)},'SIGTERM\\n');if(mode==='term-exits-zero')finish();});
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
process.stdin.resume();
if(mode==='natural-exit')finish();
else if(mode==='held-pipe-after-exit'){
  spawn(process.execPath,[${JSON.stringify(holder)}],{stdio:['ignore','inherit','inherit']});
  const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(holderPidFile)})){clearInterval(ready);finish();}},5);
}else if(mode==='output-exits-zero')process.stdout.write('x'.repeat(1_200_000),finish);
else {if(mode==='output-ignore')process.stdout.write('x'.repeat(1_200_000));setInterval(()=>{},1000);}
`, { mode: 0o700 });
  Object.assign(process.env, {
    HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "codex-home"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    CODEX_CLI_BIN: binary, CODEX_CLI_TIMEOUT_MS: "5000", CODEX_CLI_OUTPUT_MAX_BYTES: "1000000",
    AGENTFLOW_CODEX_SESSION_REUSE: "0", AGENTFLOW_CODEX_CLI_CONCURRENCY: "1", AGENTFLOW_EGRESS_LOG_DIR: path.join(root, "egress")
  });
  const { createCodexCliRunner } = await import("./codex-cli.js");
  const controller = new AbortController();
  const startedAt = Date.now();
  let settled = false;
  const execution = createCodexCliRunner().execute({ prompt: "Synthetic cancellation fixture", schema: { type: "object" }, abortSignal: controller.signal });
  const observed = execution.then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { value: undefined, error }; });
  const pid = await waitForPid(pidFile);
  if (scenario === "abort-ignore" || scenario === "term-exits-zero") controller.abort();
  if (scenario === "held-pipe-after-exit") {
    await waitForPid(holderPidFile);
    await waitForAbsence(pid);
    controller.abort(); // A completed process must win a later abort during pipe draining.
  }
  if (scenario === "abort-ignore") {
    await delay(100);
    assert.equal(settled, false, "Sending SIGTERM does not establish process exit");
    assert.equal(alive(pid), true, "The fixture intentionally ignores SIGTERM");
  }
  let bound: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    observed,
    new Promise<never>((_, reject) => {
      bound = setTimeout(() => reject(new Error("CLI completion exceeded its bounded termination window")), scenario === "timeout-ignore" ? 6500 : 3000);
    })
  ]).finally(() => { if (bound) clearTimeout(bound); });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(alive(pid), false, "The exact owned CLI must be absent before its result settles");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "Completion removes the abort listener");
  if (scenario === "natural-exit" || scenario === "held-pipe-after-exit") {
    assert.equal(result.error, undefined); assert.equal(result.value?.output, '{"summary":"synthetic complete"}');
    assert.ok(elapsedMs < 2000, "Natural completion is independent of the five-second deadline");
    controller.abort();
    if (scenario === "held-pipe-after-exit") {
      const holderPid = await waitForPid(holderPidFile);
      assert.equal(alive(holderPid), true, "Closing our pipe handles makes no descendant-cleanup claim");
      await cleanupOwnedPid(holderPidFile, holder);
    }
  } else {
    const expectedCode = scenario.startsWith("output-") ? "CODEX_CLI_OUTPUT_LIMIT" : "CODEX_CLI_TIMEOUT";
    assert.equal(result.error?.code, expectedCode);
    assert.equal(result.error?.diagnostic?.category, scenario.startsWith("output-") ? "output_limit" : "timeout");
    if (scenario.endsWith("ignore")) {
      assert.equal(result.error?.diagnostic?.signal, "SIGKILL");
      assert.match(await fs.readFile(signals, "utf8"), /SIGTERM/);
    } else {
      assert.equal(result.error?.diagnostic?.exitCode, 0, "A forced stop cannot become success because its signal handler exits zero");
    }
    assert.ok(elapsedMs < (scenario === "timeout-ignore" ? 6500 : 2000));
  }
  console.log("CODEX_CANCELLATION_OBSERVATION " + JSON.stringify({ scenario, elapsedMs, ownPidAbsent: !alive(pid), code: result.error?.code }));
});
