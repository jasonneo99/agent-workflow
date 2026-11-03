import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bindCodexToolOrigins, codexRequestEnvironment } from "../codex-origin.js";
import { registerContextGatewayTools } from "./context.js";

type Execute = Parameters<typeof registerContextGatewayTools>[1];
const origin = "123e4567-e89b-42d3-a456-426614174000";
const inheritedOrigin = "123e4567-e89b-42d3-a456-426614174001";

async function withGateway(execute: Execute, check: (client: Client) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: "synthetic-context-gateway", version: "1" });
  bindCodexToolOrigins(server);
  registerContextGatewayTools(server, execute);
  const client = new Client({ name: "synthetic-context-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await check(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("Context Gateway tools retain their public schemas and reject invalid requests before execution", async () => {
  let executions = 0;
  await withGateway(async () => {
    executions++;
    return { content: [{ type: "text", text: "unexpected execution" }] };
  }, async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), [
      "agentflow_context_report", "agentflow_context_route", "agentflow_context_status",
      "agentflow_context_calibrate", "agentflow_context_holdout", "agentflow_context_host_setup",
      "agentflow_context_host_doctor", "agentflow_context_codegen"
    ]);
    const route = tools.find(tool => tool.name === "agentflow_context_route")!;
    assert.deepEqual(route.inputSchema.required, ["project", "file", "question"]);
    assert.deepEqual(route.inputSchema.properties?.mode, {
      type: "string", enum: ["shadow", "advisory", "enforce"]
    });
    for (const arguments_ of [
      { project: "synthetic-project", file: "src/main.ts" },
      { project: "synthetic-project", file: "src/main.ts", question: "Find exports", mode: "unsupported" }
    ]) {
      const result = await client.callTool({ name: route.name, arguments: arguments_ });
      assert.equal(result.isError, true);
    }
    assert.equal(executions, 0);
  });
});

test("Context Gateway commands preserve literal flags, timeout budgets and request origin", async () => {
  const calls: Array<{ args: string[]; timeoutMs: number; origin: string | undefined }> = [];
  const project = "synthetic-project";
  const cases = [
    {
      name: "report", arguments: { project, json: true },
      argv: ["context-report", "--project", project, "--json"], timeoutMs: 60_000
    },
    {
      name: "route", arguments: { project, file: "src/main.ts", question: "Find exports" },
      argv: ["context-route", "--project", project, "--file", "src/main.ts", "--question", "Find exports"],
      timeoutMs: 60_000
    },
    {
      name: "route",
      arguments: {
        project, file: "src/main.ts", question: "Find exports", intent: "architecture",
        mode: "enforce", holdoutApproved: true, exact: true, execute: true, json: true
      },
      argv: [
        "context-route", "--project", project, "--file", "src/main.ts", "--question", "Find exports",
        "--intent", "architecture", "--mode", "enforce", "--holdout-approved", "--exact", "--execute", "--json"
      ],
      timeoutMs: 180_000
    },
    {
      name: "status", arguments: { project, json: true },
      argv: ["context-status", "--project", project, "--json"], timeoutMs: 60_000
    },
    {
      name: "calibrate", arguments: { project, corpus: "fixtures/context.json", json: true },
      argv: ["context-calibrate", "--project", project, "--corpus", "fixtures/context.json", "--json"],
      timeoutMs: 180_000
    },
    {
      name: "holdout", arguments: { project, cases: "fixtures/context.json", json: true },
      argv: ["context-holdout", "--project", project, "--cases", "fixtures/context.json", "--json"],
      timeoutMs: 60_000
    },
    {
      name: "host_setup", arguments: { project, host: "claude", write: true, json: true },
      argv: ["context-host-setup", "--project", project, "--host", "claude", "--write", "--json"],
      timeoutMs: 60_000
    },
    {
      name: "host_doctor", arguments: { project, host: "cursor", json: true },
      argv: ["context-host-doctor", "--project", project, "--host", "cursor", "--json"], timeoutMs: 60_000
    },
    {
      name: "codegen",
      arguments: {
        project, spec: "spec.md", reference: "reference.ts", target: "src/main.ts", plan: "plan.json",
        approved: true, reviewedBy: "synthetic-reviewer", validateCommand: "npm test", json: true
      },
      argv: [
        "context-codegen", "--project", project, "--spec", "spec.md", "--reference", "reference.ts",
        "--target", "src/main.ts", "--plan", "plan.json", "--approved", "--reviewed-by", "synthetic-reviewer",
        "--validate-command", "npm test", "--json"
      ],
      timeoutMs: 180_000
    }
  ];
  await withGateway(async (args, timeoutMs) => {
    const environment = codexRequestEnvironment({ CODEX_THREAD_ID: inheritedOrigin });
    calls.push({ args: [...args], timeoutMs, origin: environment.CODEX_THREAD_ID });
    return { content: [{ type: "text", text: "synthetic command result" }] };
  }, async client => {
    for (const fixture of cases) {
      const result = await client.callTool({
        name: `agentflow_context_${fixture.name}`, arguments: fixture.arguments, _meta: { threadId: origin }
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(calls.at(-1), { args: fixture.argv, timeoutMs: fixture.timeoutMs, origin });
    }
    assert.equal(calls.length, cases.length);
    await client.callTool({ name: "agentflow_context_status", arguments: { project } });
    assert.equal(calls.at(-1)?.origin, undefined, "Missing host identity must not inherit the MCP startup chat");
  });
});

test("Context Gateway forwards execution failures without retrying or dropping approval evidence", async () => {
  const expected = { content: [{ type: "text" as const, text: "Approval required for the proposed command" }], isError: true };
  let executions = 0;
  await withGateway(async () => { executions++; return expected; }, async client => {
    const result = await client.callTool({ name: "agentflow_context_codegen", arguments: { project: "synthetic-project" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, expected.content);
    assert.equal(executions, 1);
  });
});
