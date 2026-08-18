export type IdeClient = "vscode" | "cursor" | "codex";

export interface IdeConfigSnippet {
  client: IdeClient;
  relativePath: string;
  content: string;
}

export function buildIdeConfigSnippet(client: IdeClient, agentWorkflowRoot: string): IdeConfigSnippet {
  const server = {
    command: "npm",
    args: ["run", "-s", "mcp"],
    cwd: agentWorkflowRoot
  };
  if (client === "vscode") {
    return {
      client,
      relativePath: ".vscode/mcp.json",
      content: `${JSON.stringify({ servers: { agentWorkflow: { type: "stdio", ...server } } }, null, 2)}\n`
    };
  }
  if (client === "cursor") {
    return {
      client,
      relativePath: ".cursor/mcp.json",
      content: `${JSON.stringify({ mcpServers: { agentWorkflow: server } }, null, 2)}\n`
    };
  }
  return {
    client,
    relativePath: ".codex/config.toml",
    content: [
      "[mcp_servers.agent-workflow]",
      'command = "npm"',
      'args = ["run", "-s", "mcp"]',
      `cwd = ${tomlString(agentWorkflowRoot)}`,
      "startup_timeout_sec = 120",
      'default_tools_approval_mode = "writes"',
      ""
    ].join("\n")
  };
}

export function mergeIdeConfig(client: IdeClient, existing: string | undefined, snippet: IdeConfigSnippet): string {
  if (!existing?.trim()) return snippet.content;
  if (client === "codex") {
    if (/^\[mcp_servers\.agent-workflow\]\s*$/m.test(existing)) return existing;
    return `${existing.trimEnd()}\n\n${snippet.content}`;
  }
  const parsed = JSON.parse(existing) as Record<string, unknown>;
  const key = client === "vscode" ? "servers" : "mcpServers";
  const snippetParsed = JSON.parse(snippet.content) as Record<string, Record<string, unknown>>;
  const servers = isRecord(parsed[key]) ? parsed[key] as Record<string, unknown> : {};
  parsed[key] = { ...servers, agentWorkflow: snippetParsed[key]?.agentWorkflow };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
