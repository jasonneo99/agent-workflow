import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUntrustedConversationBrief,
  classifyConversationIntent,
  conversationRequestHash,
  parseConversationRequest,
  sanitizeAssistantText
} from "./index.js";

const base = {
  message: "What is the current provider status?",
  history: [{ role: "user", content: "Hello" }],
  idempotencyKey: "jarvis-chat-001",
  actor: "jarvis",
  actorRole: "operator",
  projectId: "project-123",
  capabilityMode: "conversation"
};

test("parses a bounded conversation and produces a stable body hash", () => {
  const first = parseConversationRequest(base);
  const second = parseConversationRequest(structuredClone(base));
  assert.equal(first.history.length, 1);
  assert.equal(conversationRequestHash(first), conversationRequestHash(second));
  assert.match(buildUntrustedConversationBrief(first), /untrusted conversation data/u);
});

test("rejects excess history and project paths", () => {
  assert.throws(() => parseConversationRequest({ ...base, history: Array.from({ length: 13 }, () => ({ role: "user", content: "x" })) }), /at most 12 turns/u);
  assert.throws(() => parseConversationRequest({ ...base, projectId: "/home/private/project" }), /registered project id/u);
});

test("routes substantive requests into governed workflows", () => {
  assert.deepEqual(classifyConversationIntent(parseConversationRequest({ ...base, message: "Debug the failed worker" })), {
    kind: "governed-operation",
    workflowId: "debug-failure",
    reason: "The message requests a substantive state-changing or repository operation."
  });
  assert.equal(classifyConversationIntent(parseConversationRequest(base)).kind, "conversation");
  assert.equal(classifyConversationIntent(parseConversationRequest({ ...base, message: "Could you deploy the release?" })).workflowId, "ship-release");
});

test("redacts token-shaped values and host paths from assistant text", () => {
  const output = sanitizeAssistantText("token=private-value see /Users/example/Projects/private, /etc/passwd, C:\\Users\\example\\secret and sk-abcdefghijklmnop");
  assert.doesNotMatch(output, /private-value|\/Users\/example|\/etc\/passwd|C:\\Users|sk-abcdefghijklmnop/u);
  assert.match(output, /REDACTED/u);
});
