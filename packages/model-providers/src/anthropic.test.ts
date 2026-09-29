import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AnthropicProvider } from "./anthropic.js";
import type { StageExecutionInput } from "./types.js";

test("Anthropic auto catalog falls through an unfunded model and records the attempt", async () => {
  const attempted: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-4-6" }] }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const model = (JSON.parse(body) as { model: string }).model;
      attempted.push(model);
      if (model.includes("haiku")) {
        response.writeHead(402, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Insufficient credits" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg-1", content: [{ type: "text", text: JSON.stringify({ summary: "ok", findings: [], nextAction: "done", requestedCommands: [], requestedFileWrites: [] }) }], usage: { input_tokens: 5, output_tokens: 7 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const previous = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL };
  try {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.ANTHROPIC_MODEL = "auto";
    const output = await new AnthropicProvider().executeStage({
      runId: "run", taskId: "task", workflowId: "maintain-context", workflowTask: "Summarize", stageId: "summarize", stageGoal: "summarize quickly",
      agentId: "context-curator", agentName: "Context Curator", agentPrompt: "Summarize evidence.", compiledBrief: "Synthetic brief.", modelTier: "fast", priorReceipts: [],
      projectConfig: { actions: { allowed_commands: [], blocked_commands: [], allowed_write_paths: [], blocked_write_paths: [], command_timeout_ms: 1000, max_write_bytes: 1000 } }
    } as unknown as StageExecutionInput);
    assert.deepEqual(attempted, ["claude-haiku-4-5", "claude-sonnet-4-6"]);
    assert.equal(output.summary, "ok");
    assert.equal(output.modelAttempts?.[0]?.status, 402);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restore("ANTHROPIC_API_KEY", previous.key); restore("ANTHROPIC_BASE_URL", previous.base); restore("ANTHROPIC_MODEL", previous.model);
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
