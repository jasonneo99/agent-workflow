import assert from "node:assert/strict";
import test from "node:test";
import { approvalCallbackPrompt, attachCodexOrigin, codexThreadId, failureCallbackPrompt, inheritedCodexOrigin } from "./codex-callback.js";

const threadId = "123e4567-e89b-42d3-a456-426614174000";

test("Codex origin is attached only for a valid originating task", () => {
  assert.deepEqual(attachCodexOrigin({ source: "mcp" }, { CODEX_THREAD_ID: threadId }), {
    source: "mcp",
    originClient: "codex",
    codexThreadId: threadId
  });
  assert.deepEqual(attachCodexOrigin({ source: "dashboard" }, { CODEX_THREAD_ID: "invalid" }), { source: "dashboard" });
});

test("derived runs inherit only the bounded Codex callback identity", () => {
  assert.deepEqual(inheritedCodexOrigin({ codexThreadId: threadId, secret: "not-copied" }), { originClient: "codex", codexThreadId: threadId });
  assert.equal(codexThreadId({ codexThreadId: "invalid" }), null);
});

test("approval callback asks the user without authorizing an action", () => {
  const prompt = approvalCallbackPrompt({ runId: "run-1", workflowId: "build-feature", projectName: "Example", approvalId: "approval-1", actionType: "shell", target: "npm test", rationale: "Policy requires review." });
  assert.match(prompt, /Do not call tools or change state/iu);
  assert.match(prompt, /approve and execute, approve only, reject, or dismiss/iu);
  assert.match(prompt, /approval-1/u);
});

test("failure callback requests a user decision instead of silently retrying", () => {
  const prompt = failureCallbackPrompt({ runId: "run-1", workflowId: "build-feature", projectName: "Example", status: "blocked", task: "Build the app" });
  assert.match(prompt, /inspect and repair it, retry it, or dismiss it as stale/iu);
});
