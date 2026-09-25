import assert from "node:assert/strict";
import test from "node:test";
import type { StageExecutionInput } from "./types.js";

test("Gemini uses Google's compatibility endpoint, key, client identity, and configured model", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_MODEL = "gemini-test-model";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), headers, body });
    return new Response(JSON.stringify({
      id: "gemini-response",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ outcome: "completed", summary: "Gemini ready", findings: [], nextAction: "continue", requestedCommands: [], requestedFileWrites: [] }) }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const { GeminiProvider } = await import("./gemini.js");
    const provider = new GeminiProvider();
    const output = await provider.executeStage({
      runId: "gemini-run",
      taskId: "gemini-task",
      projectConfig: { actions: { allowed_commands: [], blocked_commands: [], allowed_write_paths: [], blocked_write_paths: [], command_timeout_ms: 30_000, max_write_bytes: 4096, allowed_read_paths: [], blocked_read_paths: [], max_read_bytes: 4096 } },
      workflowId: "provider-smoke",
      workflowTask: "Verify Gemini",
      stageId: "smoke",
      agentId: "auto-test-runner",
      agentName: "Provider smoke",
      agentPrompt: "Return JSON.",
      stageGoal: "Confirm Gemini transport.",
      compiledBrief: "Synthetic public test context.",
      modelTier: "standard",
      priorReceipts: []
    } as unknown as StageExecutionInput);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer test-gemini-key");
    assert.match(calls[0]?.headers.get("x-goog-api-client") ?? "", /^agent-workflow-oai\//u);
    assert.equal(calls[0]?.body.model, "gemini-test-model");
    assert.equal(output.summary, "Gemini ready");
    assert.equal(output.artifact.provider, "gemini");
    assert.equal(output.usage?.totalTokens, 5);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = previousModel;
  }
});
