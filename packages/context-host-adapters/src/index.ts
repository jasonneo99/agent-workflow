import type { ContextRouteDecision } from "../../context-gateway/src/index.js";

export type ContextHost = "claude" | "cursor";

export type NormalizedHostRead = {
  host: ContextHost;
  filePath: string;
  content: string | null;
  exactReadRequested: boolean;
};

export function normalizeHostRead(host: ContextHost, payload: unknown): NormalizedHostRead {
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
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) throw new Error("Cursor beforeReadFile input is missing file_path.");
  return { host, filePath, content: typeof input.content === "string" ? input.content : null, exactReadRequested: false };
}

export function formatHostDecision(input: {
  host: ContextHost;
  action: "allow" | "redirect" | "promote";
  reason: string;
  route: ContextRouteDecision["route"];
  redirectCommand: string;
}): Record<string, unknown> {
  if (input.host === "claude") {
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
  return {
    relativePath: ".cursor/hooks.json",
    value: { command: "agentflow context-hook --host cursor --project .", matcher: "Read", timeout: 30, failClosed: true }
  };
}

export function mergeHostHookConfig(host: ContextHost, current: unknown): Record<string, unknown> {
  const root = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current as Record<string, unknown>) : {};
  const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks as Record<string, unknown> : {};
  root.hooks = hooks;
  const definition = hostHookDefinition(host).value;
  const event = host === "claude" ? "PreToolUse" : "beforeReadFile";
  const list = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  const marker = "agentflow context-hook";
  const exists = JSON.stringify(list).includes(marker);
  hooks[event] = exists ? list : [...list, definition];
  if (host === "cursor") root.version = typeof root.version === "number" ? root.version : 1;
  return root;
}
