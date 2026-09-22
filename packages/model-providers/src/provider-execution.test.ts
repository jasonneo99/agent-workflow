/**
 * End-to-end provider execution contract.
 *
 * The unit tests next to each provider cover helpers and parsing, but nothing
 * proved that a newly registered provider can actually execute a stage. These
 * tests close that gap:
 *
 * 1. Every provider id known to the factory resolves to a provider whose `id`
 *    matches and which exposes `executeStage`. Adding a provider file without
 *    wiring it into the factory fails here.
 * 2. The muse provider executes a full stage through the real HTTP transport
 *    with a stubbed `fetch`: request URL, auth headers, model selection, and
 *    response parsing are all exercised, with no network access.
 * 3. The mock provider round-trips a stage through the shared output contract.
 *
 * The live check at the bottom is opt-in (real API calls, costs money):
 *   AGENTFLOW_LIVE_PROVIDER_E2E=1 node --import tsx --test packages/model-providers/src/provider-execution.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider, StageExecutionInput } from "./types.js";

const PROVIDER_IDS = [
  "mock",
  "openai",
  "codex-cli",
  "anthropic",
  "muse",
  "openai-compatible",
  "byo",
  "local",
  "bedrock",
  "kiro"
] as const;

const DUMMY_ENV: Record<string, string> = {
  MUSE_API_KEY: "test-muse-key",
  OPENAI_API_KEY: "test-openai-key",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1/v1",
  OPENAI_COMPATIBLE_API_KEY: "test-compatible-key",
  BYO_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
  BYO_MODEL_API_KEY: "test-byo-key",
  KIRO_API_KEY: "test-kiro-key",
  AWS_REGION: "us-east-1"
};

function withDummyEnv(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(DUMMY_ENV)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function syntheticStageInput(): StageExecutionInput {
  return {
    runId: "run-provider-e2e",
    taskId: "task-provider-e2e",
    projectConfig: {
      actions: {
        allowed_commands: [],
        blocked_commands: [],
        allowed_write_paths: [],
        blocked_write_paths: [],
        command_timeout_ms: 30_000,
        max_write_bytes: 4096,
        allowed_read_paths: [],
        blocked_read_paths: [],
        max_read_bytes: 4096
      }
    },
    workflowId: "provider-e2e",
    workflowTask: "Prove the provider executes a stage end to end.",
    stageId: "smoke",
    agentId: "e2e-agent",
    agentName: "E2E Agent",
    agentPrompt: "Reply with the canned result.",
    stageGoal: "Return a well-formed stage result.",
    compiledBrief: "Synthetic portable context.",
    modelTier: "standard",
    priorReceipts: []
  } as unknown as StageExecutionInput;
}

test("every registered provider id resolves to a matching provider with executeStage", async () => {
  const restoreEnv = withDummyEnv();
  try {
    const { providerFromEnv } = await import("./index.js");
    for (const id of PROVIDER_IDS) {
      const provider: ModelProvider = providerFromEnv(id);
      assert.equal(provider.id, id, `providerFromEnv("${id}") returned id "${provider.id}"`);
      assert.equal(typeof provider.executeStage, "function", `${id} is missing executeStage`);
    }
  } finally {
    restoreEnv();
  }
});

test("muse provider executes a stage end to end through the HTTP transport", async () => {
  const restoreEnv = withDummyEnv();
  const previousFetch = globalThis.fetch;
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const cannedStageJson = {
    outcome: "completed",
    blockedReason: "",
    summary: "E2E stage complete via stubbed transport.",
    findings: ["stubbed transport exercised the full executeStage path"],
    nextAction: "proceed",
    requestedCommands: [],
    requestedFileWrites: []
  };
  const cannedBody = {
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: 1,
    model: "muse-spark-1.1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(cannedStageJson) },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
  };

  globalThis.fetch = (async (url: any, init: any) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        headers[String(key).toLowerCase()] = String(value);
      }
    }
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => cannedBody,
      text: async () => JSON.stringify(cannedBody)
    };
  }) as typeof fetch;

  try {
    // Dynamic import: the stub must be installed before the OpenAI SDK module loads.
    const { providerFromEnv } = await import("./index.js");
    const provider: ModelProvider = providerFromEnv("muse");
    assert.equal(provider.id, "muse");

    const output = await provider.executeStage(syntheticStageInput());

    assert.equal(seen.length, 1, `expected exactly one HTTP call, saw ${seen.length}`);
    const [call] = seen;
    assert.ok(call, "expected to capture the HTTP call");
    assert.equal(call.url, "https://api.meta.ai/v1/chat/completions");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["authorization"], "Bearer test-muse-key");
    assert.equal(call.body.model, "muse-spark-1.1");
    assert.equal(call.body.messages[0]?.role, "system");
    assert.equal(call.body.messages[1]?.role, "user");
    assert.match(call.body.messages[1]?.content ?? "", /Return a well-formed stage result/);
    assert.equal(call.body.response_format?.type, "json_object");

    assert.equal(output.outcome, "completed");
    assert.equal(output.summary, cannedStageJson.summary);
    assert.equal(output.artifact.provider, "muse");
    assert.equal(output.artifact.model, "muse-spark-1.1");
    assert.equal(output.artifact.runId, "run-provider-e2e");
    assert.deepEqual(output.requestedCommands, []);
    assert.deepEqual(output.requestedFileWrites, []);
    assert.equal(output.usage?.totalTokens, 30);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv();
  }
});

test("mock provider round-trips a stage through the shared output contract", async () => {
  const { MockProvider } = await import("./mock.js");
  const provider = new MockProvider();
  const output = await provider.executeStage(syntheticStageInput());

  assert.equal(output.outcome, "completed");
  assert.ok(output.summary.length > 0, "expected a non-empty summary");
  assert.equal(output.artifact.provider, "mock");
  assert.equal(output.artifact.runId, "run-provider-e2e");
  assert.equal(output.artifact.stageId, "smoke");
  assert.ok(Array.isArray(output.requestedCommands));
  assert.ok(Array.isArray(output.requestedFileWrites));
});

const LIVE_E2E = process.env.AGENTFLOW_LIVE_PROVIDER_E2E === "1";

test("live providers execute a real stage when credentials are configured", { skip: !LIVE_E2E }, async (t) => {
  const { providerFromEnv } = await import("./index.js");
  const results: Array<{ id: string; status: string; detail: string }> = [];
  for (const id of PROVIDER_IDS) {
    await t.test(`live executeStage: ${id}`, async () => {
      let provider: ModelProvider;
      try {
        provider = providerFromEnv(id);
      } catch (error) {
        results.push({ id, status: "skipped", detail: `construct failed: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      if (!provider.check) {
        results.push({ id, status: "skipped", detail: "provider has no check()" });
        return;
      }
      const readiness = await provider.check().catch((error: unknown) => ({
        ready: false as boolean,
        details: [error instanceof Error ? error.message : String(error)]
      }));
      if (!readiness.ready) {
        results.push({ id, status: "skipped", detail: readiness.details.join("; ") });
        return;
      }
      const output = await provider.executeStage({
        ...syntheticStageInput(),
        workflowTask: "Reply with a one-sentence live smoke result. Do not request commands or file writes.",
        stageGoal: "Return a one-sentence live smoke result."
      });
      assert.ok(typeof output.summary === "string" && output.summary.length > 0, "live stage returned an empty summary");
      assert.equal(output.artifact.provider, provider.id);
      results.push({ id, status: output.outcome ?? "completed", detail: output.summary.slice(0, 120) });
    });
  }
  console.log(`live provider e2e results:\n${JSON.stringify(results, null, 2)}`);
});
