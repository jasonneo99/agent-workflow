import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexCliDiagnostic, CodexCliProvider, configuredCodexCliModelForTier, configuredCodexCliTimeoutMs, type CodexCliRunner } from "./codex-cli.js";
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

test("Codex CLI provider requires ChatGPT auth by default and normalizes structured stage output", async () => {
  const calls: Array<{ prompt: string; model?: string; workingDirectory?: string }> = [];
  const runner: CodexCliRunner = {
    async authStatus() { return "Logged in using ChatGPT"; },
    async execute(input) {
      calls.push({ prompt: input.prompt, model: input.model, workingDirectory: input.workingDirectory });
      return {
        model: input.model ?? "codex-default",
        output: JSON.stringify({ summary: "Plan ready.", findings: ["bounded"], nextAction: "review", requestedCommands: [], requestedFileWrites: [] })
      };
    }
  };
  const previous = process.env.CODEX_CLI_MODEL_STANDARD;
  process.env.CODEX_CLI_MODEL_STANDARD = "codex-test-model";
  try {
    const provider = new CodexCliProvider(runner);
    assert.equal((await provider.check()).ready, true);
    const result = await provider.executeStage(stageInput);
    assert.equal(result.summary, "Plan ready.");
    assert.equal(result.artifact.provider, "codex-cli");
    assert.equal(result.artifact.model, "codex-test-model");
    assert.equal(calls[0]?.model, "codex-test-model");
    assert.match(calls[0]?.prompt ?? "", /inspect the supplied project checkout/i);
    assert.match(calls[0]?.prompt ?? "", /Resolve named commits with git show\/diff/);
    assert.match(calls[0]?.prompt ?? "", /Block only after those sources are genuinely absent or ambiguous/);
    assert.equal(calls[0]?.workingDirectory, "/tmp/synthetic-project");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_MODEL_STANDARD;
    else process.env.CODEX_CLI_MODEL_STANDARD = previous;
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
  try {
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

test("Codex CLI diagnostics retain only an allowlisted type and digest", () => {
  const rawDetail = "failed in /Users/example/Private Project with token=ghp_supersecret and postgres://user:pass@localhost/db; stream disconnected";
  const diagnostic = buildCodexCliDiagnostic({ rawDetail, errorCode: "CODEX_CLI_EXIT_1", exitCode: 1 });
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.category, "transport");
  assert.equal(diagnostic.retryable, true);
  assert.match(diagnostic.digest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(serialized, /Users|Private Project|supersecret|postgres|user:pass/u);
});
