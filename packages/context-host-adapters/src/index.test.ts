import assert from "node:assert/strict";
import test from "node:test";
import { formatHostDecision, mergeHostHookConfig, normalizeHostRead } from "./index.js";

test("Claude adapter recognizes targeted reads and emits structured PreToolUse denial", () => {
  const read = normalizeHostRead("claude", { tool_name: "Read", tool_input: { file_path: "/repo/a.ts", offset: 10, limit: 20 } });
  assert.equal(read.exactReadRequested, true);
  const output = formatHostDecision({ host: "claude", action: "redirect", reason: "large read", route: "delegate", redirectCommand: "agentflow context-route" });
  assert.equal((output.hookSpecificOutput as Record<string, unknown>).permissionDecision, "deny");
});

test("Cursor adapter consumes beforeReadFile content and denies with a user message", () => {
  const read = normalizeHostRead("cursor", { file_path: "/repo/a.ts", content: "source" });
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
