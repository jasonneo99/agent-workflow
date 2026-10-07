import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { approvalCallbackPrompt, attachCodexOrigin, codexThreadId, failureCallbackPrompt, inheritedCodexOrigin } from "./codex-callback.js";

const threadId = "123e4567-e89b-42d3-a456-426614174000";

test("callback process success proves transport only, never task acknowledgment", async () => {
  const source = await readFile(new URL("./lib/builders-approvals.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function deliverCodexWorkflowCallback(");
  const end = source.indexOf("export async function deliverOneRunNotification", start);
  assert.ok(start >= 0 && end > start);
  const js = ts.transpileModule(source.slice(start, end).replace("export async", "async"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  for (const failed of [false, true]) {
    let calls = 0;
    const context = vm.createContext({ process: { env: {} }, execFile: (_binary: string, argv: string[], _options: unknown, callback: (error: Error | null) => void) => {
      calls++;
      assert.deepEqual(Array.from(argv).slice(0, 4), ["exec", "resume", "--all", threadId]);
      callback(failed ? new Error("synthetic offline") : null);
    } });
    vm.runInContext(js, context);
    const result = await context.deliverCodexWorkflowCallback({ threadId, projectDir: "/synthetic", prompt: "synthetic status" });
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { transportDelivered: !failed, acknowledged: false });
  }
});

test("supported UUID origins survive capture, serialization and repeated inheritance", () => {
  for (const version of "12345678") {
    const id = `01234567-89ab-${version}cde-8f01-23456789abcd`;
    const captured = attachCodexOrigin({ source: "synthetic" }, { CODEX_THREAD_ID: id });
    assert.equal(codexThreadId(captured), id);
    const restored = JSON.parse(JSON.stringify(captured));
    assert.strictEqual(attachCodexOrigin(restored, { CODEX_THREAD_ID: threadId }), restored);
    assert.deepEqual(inheritedCodexOrigin(inheritedCodexOrigin(restored)), { originClient: "codex", codexThreadId: id });
    assert.equal(codexThreadId({ codexThreadId: ` ${id.toUpperCase()} ` }), id.toUpperCase());
  }
});

test("invalid explicit origins fail closed without environment retargeting", () => {
  for (const id of ["invalid", "", null, undefined, 7, "01234567-89ab-0cde-8f01-23456789abcd", "01234567-89ab-9cde-8f01-23456789abcd", "01234567-89ab-7cde-cf01-23456789abcd", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    const metadata = { source: "synthetic", codexThreadId: id };
    assert.strictEqual(attachCodexOrigin(metadata, { CODEX_THREAD_ID: threadId }), metadata);
    assert.equal(codexThreadId(metadata), null);
    assert.deepEqual(inheritedCodexOrigin(metadata), {});
  }
});

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
