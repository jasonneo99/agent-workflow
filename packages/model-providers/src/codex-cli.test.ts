import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexCliDiagnostic, CodexCliProvider, codexStderrExcerpt, configuredCodexCliDirectRepoInspection, configuredCodexCliMaxResumes, configuredCodexCliModelForTier, configuredCodexCliOutputMaxBytes, configuredCodexCliSessionReuse, configuredCodexCliTimeoutMs, createCodexCliRunner, parseCodexCliThreadId, parseCodexCliUsage, type CodexCliRunner } from "./codex-cli.js";
import type { StageExecutionInput } from "./types.js";

const stageInput = {
  runId: "run-codex-cli",
  taskId: "task-codex-cli",
  projectRootUri: "/tmp/synthetic-project",
  projectConfig: {
    actions: {
      allowed_commands: [], blocked_commands: [], allowed_write_paths: [], blocked_write_paths: [],
      command_timeout_ms: 30_000, max_write_bytes: 4096
    }
  },
  workflowId: "build-feature",
  workflowTask: "Prove the adapter contract",
  stageId: "plan",
  agentId: "technical-architect",
  agentName: "Technical Architect",
  agentPrompt: "Return a bounded plan.",
  stageGoal: "Create a plan.",
  compiledBrief: "Synthetic portable context.",
  modelTier: "standard",
  priorReceipts: []
} as unknown as StageExecutionInput;

test('strict Codex schema can express a bounded source proposal and evidence influence as structured artifact fields',async()=>{
 const paths=['src/synthetic.ts','tests/synthetic.test.ts'],memoryInfluence={used:[],noInfluenceReason:'No earlier comparison was needed.'};
 let schema:any;
 const provider=new CodexCliProvider({authStatus:async()=> 'Logged in using ChatGPT',execute:async input=>{
  schema=input.schema;
  return {model:'synthetic-model',output:JSON.stringify({outcome:'completed',summary:'Read-only discovery',proposedSourcePaths:paths,memoryInfluence})};
 }});
 const result=await provider.executeStage({...stageInput,agentId:'queue-partner'});
 assert.equal(schema.additionalProperties,false);assert.ok(schema.required.includes('proposedSourcePaths'));assert.ok(schema.required.includes('memoryInfluence'));
 assert.equal(schema.properties.proposedSourcePaths.maxItems,40);assert.equal(schema.properties.proposedSourcePaths.items.maxLength,500);
 assert.deepEqual(schema.properties.memoryInfluence.type,['object','null']);assert.equal(schema.properties.memoryInfluence.additionalProperties,false);
 assert.equal(schema.properties.memoryInfluence.properties.used.maxItems,12);
 assert.deepEqual(schema.properties.memoryInfluence.properties.used.items.properties.effect.enum,['changed-plan','confirmed-plan','rejected']);
 assert.deepEqual(result.artifact.proposedSourcePaths,paths);assert.deepEqual(result.artifact.memoryInfluence,memoryInfluence);
 assert.deepEqual(result.requestedCommands,[]);assert.deepEqual(result.requestedFileWrites,[]);
});

test("Codex CLI provider requires ChatGPT auth by default and normalizes structured stage output", async () => {
  const calls: Array<{ prompt: string; model?: string; reasoningEffort?: string; workingDirectory?: string; sessionKey?: string; schema: Record<string, unknown> }> = [];
  const runner: CodexCliRunner = {
    async authStatus() { return "Logged in using ChatGPT"; },
    async execute(input) {
      calls.push({ prompt: input.prompt, model: input.model, reasoningEffort: input.reasoningEffort, workingDirectory: input.workingDirectory, sessionKey: input.sessionKey, schema: input.schema });
      return {
        model: input.model ?? "codex-default",
        output: JSON.stringify({ summary: "Plan ready.", findings: ["bounded"], nextAction: "review", requestedCommands: [], requestedFileReads: [], requestedFileWrites: [] })
      };
    }
  };
  const previous = process.env.CODEX_CLI_MODEL_STANDARD;
  const previousInspection = process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION;
  process.env.CODEX_CLI_MODEL_STANDARD = "codex-test-model";
  process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION = "1";
  try {
    const provider = new CodexCliProvider(runner);
    assert.equal((await provider.check()).ready, true);
    const result = await provider.executeStage(stageInput);
    assert.equal(result.summary, "Plan ready.");
    assert.equal(result.artifact.provider, "codex-cli");
    assert.equal(result.artifact.model, "codex-test-model");
    assert.equal(calls[0]?.model, "codex-test-model");
    assert.equal(calls[0]?.reasoningEffort, "low");
    assert.equal(calls[0]?.sessionKey, undefined);
    assert.match(calls[0]?.prompt ?? "", /Direct repository inspection is disabled/i);
    assert.match(calls[0]?.prompt ?? "", /request exact additional files through requestedFileReads/i);
    assert.match(calls[0]?.prompt ?? "", /Request policy-governed commands and file writes in the structured output/i);
    assert.equal(calls[0]?.workingDirectory, undefined);
    const schema = calls[0]?.schema as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(schema.properties?.requestedFileReads);
    assert.ok(schema.required?.includes("requestedFileReads"));
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_MODEL_STANDARD;
    else process.env.CODEX_CLI_MODEL_STANDARD = previous;
    if (previousInspection === undefined) delete process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION;
    else process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION = previousInspection;
  }
});

test("Codex CLI direct repository inspection remains disabled under the deprecated setting", () => {
  const previous = process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION;
  try {
    delete process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION;
    assert.equal(configuredCodexCliDirectRepoInspection(), false);
    process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION = "true";
    assert.equal(configuredCodexCliDirectRepoInspection(), false);
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION;
    else process.env.AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION = previous;
  }
});

test("Codex CLI provider fails closed when the configured auth mode does not match", async () => {
  const previous = process.env.CODEX_CLI_AUTH_MODE;
  process.env.CODEX_CLI_AUTH_MODE = "chatgpt";
  try {
    const provider = new CodexCliProvider({
      async authStatus() { return "Logged in using an API key"; },
      async execute() { throw new Error("must not execute"); }
    });
    const readiness = await provider.check();
    assert.equal(readiness.ready, false);
    await assert.rejects(() => provider.executeStage(stageInput), /does not satisfy/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_AUTH_MODE;
    else process.env.CODEX_CLI_AUTH_MODE = previous;
  }
});

test("Codex CLI model selection honors override, tier, base, then CLI default", () => {
  const previousBase = process.env.CODEX_CLI_MODEL;
  const previousFast = process.env.CODEX_CLI_MODEL_FAST;
  const previousStandard = process.env.CODEX_CLI_MODEL_STANDARD;
  const previousReasoning = process.env.CODEX_CLI_MODEL_REASONING;
  try {
    delete process.env.CODEX_CLI_MODEL_STANDARD;
    delete process.env.CODEX_CLI_MODEL_REASONING;
    process.env.CODEX_CLI_MODEL = "base-model";
    process.env.CODEX_CLI_MODEL_FAST = "fast-model";
    assert.equal(configuredCodexCliModelForTier("fast"), "fast-model");
    assert.equal(configuredCodexCliModelForTier("standard"), "base-model");
    assert.equal(configuredCodexCliModelForTier("fast", "override-model"), "override-model");
    delete process.env.CODEX_CLI_MODEL;
    delete process.env.CODEX_CLI_MODEL_FAST;
    assert.equal(configuredCodexCliModelForTier("reasoning"), undefined);
  } finally {
    if (previousBase === undefined) delete process.env.CODEX_CLI_MODEL;
    else process.env.CODEX_CLI_MODEL = previousBase;
    if (previousFast === undefined) delete process.env.CODEX_CLI_MODEL_FAST;
    else process.env.CODEX_CLI_MODEL_FAST = previousFast;
    if (previousStandard === undefined) delete process.env.CODEX_CLI_MODEL_STANDARD;
    else process.env.CODEX_CLI_MODEL_STANDARD = previousStandard;
    if (previousReasoning === undefined) delete process.env.CODEX_CLI_MODEL_REASONING;
    else process.env.CODEX_CLI_MODEL_REASONING = previousReasoning;
  }
});

test("Codex CLI JSONL usage is normalized for route accounting", () => {
  assert.deepEqual(parseCodexCliUsage([
    JSON.stringify({ type: "thread.started", thread_id: "synthetic" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } })
  ].join("\n")), { inputTokens: 120, cachedInputTokens: 20, reasoningTokens: undefined, outputTokens: 30, totalTokens: 150 });
});

test("Codex CLI session reuse remains disabled under the deprecated setting and captures thread ids", () => {
  const previous = process.env.AGENTFLOW_CODEX_SESSION_REUSE;
  try {
    delete process.env.AGENTFLOW_CODEX_SESSION_REUSE;
    assert.equal(configuredCodexCliSessionReuse(), false);
    process.env.AGENTFLOW_CODEX_SESSION_REUSE = "1";
    assert.equal(configuredCodexCliSessionReuse(), false);
    assert.equal(parseCodexCliThreadId(JSON.stringify({ type: "thread.started", thread_id: "cf815d03-6423-4520-bf3c-5d486203260b" })), "cf815d03-6423-4520-bf3c-5d486203260b");
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_CODEX_SESSION_REUSE;
    else process.env.AGENTFLOW_CODEX_SESSION_REUSE = previous;
  }
});

test("Codex CLI JSONL output has a configurable bounded allowance", () => {
  const previous = process.env.CODEX_CLI_OUTPUT_MAX_BYTES;
  try {
    delete process.env.CODEX_CLI_OUTPUT_MAX_BYTES;
    assert.equal(configuredCodexCliOutputMaxBytes(), 8_000_000);
    process.env.CODEX_CLI_OUTPUT_MAX_BYTES = "500000";
    assert.equal(configuredCodexCliOutputMaxBytes(), 1_000_000);
    process.env.CODEX_CLI_OUTPUT_MAX_BYTES = "99999999";
    assert.equal(configuredCodexCliOutputMaxBytes(), 32_000_000);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_OUTPUT_MAX_BYTES;
    else process.env.CODEX_CLI_OUTPUT_MAX_BYTES = previous;
  }
});

test("Codex CLI timeout supports long implementation stages with safe bounds", () => {
  const previous = process.env.CODEX_CLI_TIMEOUT_MS;
  try {
    delete process.env.CODEX_CLI_TIMEOUT_MS;
    assert.equal(configuredCodexCliTimeoutMs(), 900_000);
    process.env.CODEX_CLI_TIMEOUT_MS = "1800000";
    assert.equal(configuredCodexCliTimeoutMs(), 1_800_000);
    process.env.CODEX_CLI_TIMEOUT_MS = "1";
    assert.equal(configuredCodexCliTimeoutMs(), 5_000);
    process.env.CODEX_CLI_TIMEOUT_MS = "99999999";
    assert.equal(configuredCodexCliTimeoutMs(), 3_600_000);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_TIMEOUT_MS;
    else process.env.CODEX_CLI_TIMEOUT_MS = previous;
  }
});

test("Codex CLI diagnostics carry a redacted stderr excerpt, never cleartext secrets", () => {
  // Contract changed 2026-10-01 (Codex diagnostic fix #1): the failure evidence
  // is surfaced as a redacted excerpt instead of being hashed away. Secrets
  // must still never appear in cleartext.
  const rawDetail = "failed in /Users/example/Private Project with token=ghp_supersecret and postgres://user:pass@localhost/db; stream disconnected";
  const diagnostic = buildCodexCliDiagnostic({ rawDetail, errorCode: "CODEX_CLI_EXIT_1", exitCode: 1 });
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.category, "transport");
  assert.equal(diagnostic.retryable, true);
  assert.match(diagnostic.digest, /^[a-f0-9]{64}$/u);
  assert.match(diagnostic.stderrExcerpt ?? "", /stream disconnected/);
  assert.doesNotMatch(serialized, /ghp_supersecret|user:pass/u);
  assert.match(serialized, /\[redacted\]/);
});

test("Codex CLI process launches use a configurable bounded cross-process slot pool", () => {
  const source = readFileSync(new URL("./codex-cli.ts", import.meta.url), "utf8");
  assert.match(source, /withCodexCliProcessLock[\s\S]+configuredCodexCliConcurrency\(\)[\s\S]+slot < concurrency[\s\S]+fs\.open\(candidate, "wx", 0o600\)[\s\S]+process\.kill\(pid, 0\)[\s\S]+await operation\(\)/u);
  assert.match(source, /configuredCodexCliConcurrency[\s\S]+Math\.max\(1, Math\.min\(16[\s\S]+AGENTFLOW_CODEX_CLI_CONCURRENCY/u);
});

test("Codex CLI resolves a PATH entry before spawning and exposes only the safe spawn code", () => {
  const source = readFileSync(new URL("./codex-cli.ts", import.meta.url), "utf8");
  assert.match(source, /resolveCodexCliBinary[\s\S]+process\.env\.PATH[\s\S]+existsSync\(candidate\)/u);
  assert.match(source, /safeCode = diagnostic\.errorCode/u);
});

// ---------------------------------------------------------------------------
// Codex CLI reliability fixes (2026-10-01 diagnostic)
// ---------------------------------------------------------------------------

async function withTempEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  // Fake CLI commands must not share production execution slots or sessions.
  // Each caller already owns and cleans this disposable fixture directory.
  vars = { TMPDIR: vars.AGENTFLOW_EGRESS_LOG_DIR, TMP: vars.AGENTFLOW_EGRESS_LOG_DIR, TEMP: vars.AGENTFLOW_EGRESS_LOG_DIR, ...vars };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeStubScript(dir: string, body: string): Promise<string> {
  const bin = path.join(dir, `codex-stub-${process.pid}-${Date.now()}`);
  await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo 'codex-cli 0.160.0'\n  exit 0\nfi\n${body}\n`, { mode: 0o755 });
  return bin;
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Historical pointer location, used only to prove legacy sessions stay untouched. */
function stubSessionFile(sessionKey: string): { dir: string; file: string } {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const dir = path.join(os.tmpdir(), `agentflow-codex-sessions-${uid}`);
  return { dir, file: path.join(dir, `${createHash("sha256").update(sessionKey).digest("hex")}.json`) };
}

const stubThreadId = "12345678-1234-1234-1234-123456789abc";

test("codexStderrExcerpt collapses whitespace, truncates, and redacts secrets", () => {
  const excerpt = codexStderrExcerpt("  fatal   error\napi_key=sk-abc123XYZ789  bearer abcdefgh12345678  ");
  assert.doesNotMatch(excerpt, /sk-abc123/);
  assert.doesNotMatch(excerpt, /abcdefgh12345678/);
  assert.match(excerpt, /\[redacted\]/);
  assert.match(excerpt, /fatal error/);
  assert.ok(!/ {2,}/.test(excerpt), "whitespace collapsed");
  const long = codexStderrExcerpt("x".repeat(5000));
  assert.ok(long.length < 5000 && long.endsWith("[truncated]"));
});

test("Codex CLI runner surfaces redacted stderr excerpt and exit code on non-zero exit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  try {
    await withTempEnv({ AGENTFLOW_CODEX_SESSION_REUSE: "0", CODEX_CLI_BIN: undefined, AGENTFLOW_EGRESS_LOG_DIR: dir }, async () => {
      const bin = await writeStubScript(dir, 'echo "fatal: api_key=sk-abc123secretvalue exploded" >&2\nexit 3');
      process.env.CODEX_CLI_BIN = bin;
      const runner = createCodexCliRunner();
      await assert.rejects(
        () => runner.execute({ prompt: "hi", schema: { type: "object" }, sessionKey: `test-excerpt-${Date.now()}` }),
        (error: unknown) => {
          const err = error as Error & { code?: string; diagnostic?: { exitCode?: number; stderrExcerpt?: string } };
          assert.match(err.message, /exploded/);
          assert.doesNotMatch(err.message, /sk-abc123secretvalue/);
          assert.match(err.message, /\[redacted\]/);
          assert.equal(err.code, "CODEX_CLI_EXIT_3");
          assert.equal(err.diagnostic?.exitCode, 3);
          assert.match(err.diagnostic?.stderrExcerpt ?? "", /exploded/);
          return true;
        }
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex CLI runner raises CODEX_CLI_TURN_FAILED on exit-0 with turn.failed (not ENOENT)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  try {
    await withTempEnv({ AGENTFLOW_CODEX_SESSION_REUSE: "0", CODEX_CLI_BIN: undefined, AGENTFLOW_EGRESS_LOG_DIR: dir }, async () => {
      // Exits 0, reports turn.failed in the JSONL stream, never writes --output-last-message.
      const bin = await writeStubScript(dir, `echo '{"type":"turn.failed","error":"boom"}'\nexit 0`);
      process.env.CODEX_CLI_BIN = bin;
      const runner = createCodexCliRunner();
      await assert.rejects(
        () => runner.execute({ prompt: "hi", schema: { type: "object" }, sessionKey: `test-turnfailed-${Date.now()}` }),
        (error: unknown) => {
          const err = error as Error & { code?: string };
          assert.equal(err.code, "CODEX_CLI_TURN_FAILED");
          assert.match(err.message, /turn\.failed/i);
          assert.doesNotMatch(err.message, /ENOENT/);
          return true;
        }
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex CLI runner reports signal kills with the signal name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  try {
    await withTempEnv({ AGENTFLOW_CODEX_SESSION_REUSE: "0", CODEX_CLI_BIN: undefined, AGENTFLOW_EGRESS_LOG_DIR: dir }, async () => {
      const bin = await writeStubScript(dir, "kill -9 $$");
      process.env.CODEX_CLI_BIN = bin;
      const runner = createCodexCliRunner();
      await assert.rejects(
        () => runner.execute({ prompt: "hi", schema: { type: "object" }, sessionKey: `test-signal-${Date.now()}` }),
        (error: unknown) => {
          const err = error as Error & { code?: string; diagnostic?: { signal?: string } };
          assert.equal(err.code, "CODEX_CLI_SIGNAL");
          assert.equal(err.diagnostic?.signal, "SIGKILL");
          assert.match(err.message, /SIGKILL/);
          return true;
        }
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex CLI runner reports spawn_unavailable when the binary is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  try {
    await withTempEnv({ AGENTFLOW_CODEX_SESSION_REUSE: "0", AGENTFLOW_EGRESS_LOG_DIR: dir }, async () => {
      process.env.CODEX_CLI_BIN = "/nonexistent/codex-binary-xyz";
      const runner = createCodexCliRunner();
      await assert.rejects(
        () => runner.execute({ prompt: "hi", schema: { type: "object" }, sessionKey: `test-spawn-${Date.now()}` }),
        (error: unknown) => {
          const err = error as Error & { code?: string; retryable?: boolean };
          assert.match(err.message, /spawn unavailable/i);
          assert.equal(err.retryable, false);
          return true;
        }
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex CLI runner ignores legacy session pointers and starts every call fresh", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
  const sessionKey = `test-fresh-${Date.now()}`;
  try {
    await withTempEnv({ AGENTFLOW_CODEX_SESSION_REUSE: "1", CODEX_CLI_MAX_RESUMES: "3", CODEX_CLI_BIN: undefined, AGENTFLOW_EGRESS_LOG_DIR: dir }, async () => {
      assert.equal(configuredCodexCliSessionReuse(), false);
      assert.equal(configuredCodexCliMaxResumes(), 0);
      const { dir: sessDir, file: sessFile } = stubSessionFile(sessionKey);
      assert.equal(path.dirname(sessDir), dir, "legacy fixture stays in its owned temporary directory");
      await mkdir(sessDir, { recursive: true, mode: 0o700 });
      const legacyPointer = JSON.stringify({ threadId: stubThreadId, resumeCount: 0, createdAt: Date.now() });
      await writeFile(sessFile, legacyPointer, { mode: 0o600 });
      const initialPointers = await readdir(sessDir);
      const countFile = path.join(dir, "count");
      const argsFile = path.join(dir, "args");
      const bin = await writeStubScript(dir, `
[ "$1" = "exec" ] || exit 9
count_file=${shellQuote(countFile)}
args_file=${shellQuote(argsFile)}
count=$(cat "$count_file" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$count_file"
printf '%s\\n' "$@" > "$args_file.$count"
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$a"; fi
  prev="$a"
done
echo '{"type":"thread.started","thread_id":"abcdefab-abcd-abcd-abcd-abcdefabcdef"}'
echo '{"type":"turn.completed"}'
printf '{"summary":"fresh"}' > "$out"
exit 0`.trim());
      process.env.CODEX_CLI_BIN = bin;
      const runner = createCodexCliRunner();
      for (let call = 1; call <= 2; call += 1) {
        const result = await runner.execute({ prompt: "hi", schema: { type: "object" }, sessionKey });
        assert.equal(result.output, '{"summary":"fresh"}');
        const args = (await readFile(`${argsFile}.${call}`, "utf8")).trimEnd().split("\n");
        assert.equal(args[0], "exec");
        assert.ok(args.includes("--ephemeral"));
        assert.ok(!args.includes("resume"));
        assert.equal(await readFile(sessFile, "utf8"), legacyPointer);
        assert.deepEqual(await readdir(sessDir), initialPointers, "no session pointer is created");
      }
      assert.equal((await readFile(countFile, "utf8")).trim(), "2");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
