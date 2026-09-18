import assert from "node:assert/strict";
import test from "node:test";
import { formatHostDecision, mergeHostHookConfig, normalizeHostRead } from "./index.js";

test("Claude adapter recognizes targeted reads and emits structured PreToolUse denial", () => {
  const read = normalizeHostRead("claude", { tool_name: "Read", tool_input: { file_path: "/repo/a.ts", offset: 10, limit: 20 } });
  assert.ok(read);
  assert.equal(read.exactReadRequested, true);
  const output = formatHostDecision({ host: "claude", action: "redirect", reason: "large read", route: "delegate", redirectCommand: "agentflow context-route" });
  assert.equal((output.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
});

test("Cursor adapter consumes beforeReadFile content and denies with a user message", () => {
  const read = normalizeHostRead("cursor", { file_path: "/repo/a.ts", content: "source" });
  assert.ok(read);
  assert.equal(read.content, "source");
  assert.deepEqual(formatHostDecision({ host: "cursor", action: "redirect", reason: "large read", route: "delegate", redirectCommand: "agentflow context-route" }), { permission: "deny", user_message: "large read Use: agentflow context-route" });
});

test("host hook configuration merges without deleting existing hooks or duplicating itself", () => {
  const current = { version: 1, hooks: { beforeReadFile: [{ command: "existing" }] } };
  const once = mergeHostHookConfig("cursor", current);
  const twice = mergeHostHookConfig("cursor", once);
  assert.equal((twice.hooks as Record<string, unknown[]>).beforeReadFile.length, 2);
  assert.match(JSON.stringify(twice), /existing/u);
});

test("Codex adapter routes dedicated and simple broad reads but leaves targeted shell commands alone", () => {
  assert.equal(normalizeHostRead("codex", { tool_name: "mcp__fs__read", tool_input: { path: "/repo/a.ts" } })?.filePath, "/repo/a.ts");
  assert.equal(normalizeHostRead("codex", { tool_name: "Bash", tool_input: { command: "cat 'src/large file.ts'" } })?.filePath, "src/large file.ts");
  assert.equal(normalizeHostRead("codex", { tool_name: "Bash", tool_input: { command: "rg -n authorize src" } }), null);
  assert.equal(normalizeHostRead("codex", { tool_name: "Bash", tool_input: { command: "cat a.ts | head" } }), null);
  const output = formatHostDecision({ host: "codex", action: "redirect", reason: "large read", route: "delegate", redirectCommand: "agentflow_context_route" });
  assert.equal((output.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
});

test("Codex hook configuration includes session guidance and pre-tool routing once", () => {
  const once = mergeHostHookConfig("codex", { hooks: { SessionStart: [{ matcher: "existing" }] } });
  const twice = mergeHostHookConfig("codex", once);
  const hooks = twice.hooks as Record<string, unknown[]>;
  assert.equal(hooks.SessionStart.length, 2);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.match(JSON.stringify(twice), /context-session-hook|context-hook --host codex/u);
});
