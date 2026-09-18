import type { ContextRouteDecision } from "../../context-gateway/src/index.js";

export type ContextHost = "claude" | "cursor" | "codex";

export type NormalizedHostRead = {
  host: ContextHost;
  filePath: string;
  content: string | null;
  exactReadRequested: boolean;
};

export function normalizeHostRead(host: ContextHost, payload: unknown): NormalizedHostRead | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Hook input must be a JSON object.");
  const input = payload as Record<string, unknown>;
  if (host === "claude") {
    if (input.tool_name !== "Read") throw new Error("Claude adapter accepts only Read PreToolUse events.");
    const tool = input.tool_input;
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error("Claude Read input is missing tool_input.");
    const read = tool as Record<string, unknown>;
    const filePath = typeof read.file_path === "string" ? read.file_path : typeof read.path === "string" ? read.path : "";
    if (!filePath) throw new Error("Claude Read input is missing file_path.");
    return { host, filePath, content: null, exactReadRequested: Number.isFinite(read.offset) || Number.isFinite(read.limit) };
  }
  if (host === "cursor") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    if (!filePath) throw new Error("Cursor beforeReadFile input is missing file_path.");
    return { host, filePath, content: typeof input.content === "string" ? input.content : null, exactReadRequested: false };
  }
  const tool = input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input)
    ? input.tool_input as Record<string, unknown>
    : {};
  const directPath = typeof tool.file_path === "string" ? tool.file_path : typeof tool.path === "string" ? tool.path : "";
  if (directPath) return { host, filePath: directPath, content: null, exactReadRequested: Number.isFinite(tool.offset) || Number.isFinite(tool.limit) };
  const command = typeof tool.command === "string" ? tool.command : typeof tool.cmd === "string" ? tool.cmd : "";
  const filePath = parseSimpleCatPath(command);
  return filePath ? { host, filePath, content: null, exactReadRequested: false } : null;
}

export function formatHostDecision(input: {
  host: ContextHost;
  action: "allow" | "redirect" | "promote";
  reason: string;
  route: ContextRouteDecision["route"];
  redirectCommand: string;
}): Record<string, unknown> {
  if (input.host === "claude" || input.host === "codex") {
    if (input.action === "allow" || input.action === "promote") return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${input.reason} Use: ${input.redirectCommand}` } };
  }
  if (input.action === "allow" || input.action === "promote") return { permission: "allow" };
  return { permission: "deny", user_message: `${input.reason} Use: ${input.redirectCommand}` };
}

export function hostHookDefinition(host: ContextHost): { relativePath: string; value: Record<string, unknown> } {
  if (host === "claude") return {
    relativePath: ".claude/settings.json",
    value: { matcher: "Read", hooks: [{ type: "command", command: "agentflow context-hook --host claude --project \"$CLAUDE_PROJECT_DIR\"", timeout: 30 }] }
  };
  if (host === "cursor") return {
    relativePath: ".cursor/hooks.json",
    value: { command: "agentflow context-hook --host cursor --project .", matcher: "Read", timeout: 30, failClosed: true }
  };
  return {
    relativePath: ".codex/hooks.json",
    value: { hooks: {
      SessionStart: [{ matcher: "^(startup|resume|compact)$", hooks: [{ type: "command", command: "agentflow context-session-hook --host codex", timeout: 30, statusMessage: "Loading governed context routing" }] }],
      PreToolUse: [{ matcher: "^(Bash|exec_command|mcp__.*__(read|open|get).*)$", hooks: [{ type: "command", command: "agentflow context-hook --host codex --project \"$(git rev-parse --show-toplevel)\"", timeout: 30, statusMessage: "Checking governed context route" }] }]
    } }
  };
}

export function mergeHostHookConfig(host: ContextHost, current: unknown): Record<string, unknown> {
  const root = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current as Record<string, unknown>) : {};
  const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks as Record<string, unknown> : {};
  root.hooks = hooks;
  const definition = hostHookDefinition(host).value;
  if (host === "codex") {
    const definedHooks = definition.hooks as Record<string, unknown[]>;
    for (const [event, additions] of Object.entries(definedHooks)) {
      const list = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
      for (const addition of additions) {
        const marker = JSON.stringify(addition).includes("context-session-hook") ? "context-session-hook" : "context-hook --host codex";
        if (!JSON.stringify(list).includes(marker)) list.push(addition);
      }
      hooks[event] = list;
    }
    return root;
  }
  const event = host === "claude" ? "PreToolUse" : "beforeReadFile";
  const list = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  const marker = "agentflow context-hook";
  const exists = JSON.stringify(list).includes(marker);
  hooks[event] = exists ? list : [...list, definition];
  if (host === "cursor") root.version = typeof root.version === "number" ? root.version : 1;
  return root;
}

function parseSimpleCatPath(command: string): string | null {
  if (!command || /[;&|<>`$()\n\r]/u.test(command)) return null;
  const match = command.trim().match(/^cat(?:\s+--)?\s+(?:'([^']+)'|"([^"]+)"|(\S+))$/u);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}
