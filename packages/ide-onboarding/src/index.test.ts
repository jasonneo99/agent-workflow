import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeConfigSnippet, mergeIdeConfig } from "./index.js";

test("builds client-specific MCP configurations", () => {
  assert.match(buildIdeConfigSnippet("vscode", "/agent workflow").content, /"servers"/);
  assert.match(buildIdeConfigSnippet("cursor", "/agent workflow").content, /"mcpServers"/);
  assert.match(buildIdeConfigSnippet("codex", "/agent workflow").content, /\[mcp_servers\.agent-workflow\]/);
});

test("merges JSON config without removing existing servers", () => {
  const snippet = buildIdeConfigSnippet("vscode", "/agent-workflow");
  const merged = JSON.parse(mergeIdeConfig("vscode", '{"servers":{"existing":{"command":"x"}},"inputs":[]}', snippet));
  assert.equal(merged.servers.existing.command, "x");
  assert.equal(merged.servers.agentWorkflow.cwd, "/agent-workflow");
  assert.deepEqual(merged.inputs, []);
});

test("does not duplicate an existing Codex MCP table", () => {
  const existing = '[mcp_servers.agent-workflow]\ncommand = "custom"\n';
  const snippet = buildIdeConfigSnippet("codex", "/agent-workflow");
  assert.equal(mergeIdeConfig("codex", existing, snippet), existing);
});
