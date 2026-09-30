#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-plugin-smoke-"));
const transport = new StdioClientTransport({
  command: "bash",
  args: [path.join(pluginRoot, "scripts", "run-agent-workflow-mcp.sh")],
  cwd: pluginRoot,
  env: {
    ...process.env,
    HOME: temporaryHome,
    XDG_CACHE_HOME: path.join(temporaryHome, "cache"),
    AGENTFLOW_PLUGIN_FORCE_ARCHIVE: "1",
    AGENT_WORKFLOW_HOME: "/definitely/not/installed"
  }
});
const client = new Client({ name: "agent-workflow-plugin-smoke", version: "0.0.0" });

try {
  await client.connect(transport);
  const result = await client.listTools();
  if (result.tools.length < 1) throw new Error("Bundled MCP runtime returned no tools");
  console.log(JSON.stringify({ status: "passed", toolCount: result.tools.length }));
} finally {
  await client.close().catch(() => {});
}
