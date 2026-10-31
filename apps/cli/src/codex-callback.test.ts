import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { approvalCallbackPrompt, attachCodexOrigin, codexThreadId, failureCallbackPrompt, inheritedCodexOrigin, runNotificationCallbackPrompt } from "./codex-callback.js";

const threadId = "123e4567-e89b-42d3-a456-426614174000";

test("Studio and Muse origins survive inheritance without becoming Codex origins", () => {
  for (const channel of ["studio", "muse"]) {
    const origin = attachCodexOrigin({}, { AGENTFLOW_REQUESTER_CHANNEL: channel, AGENTFLOW_ORIGIN_TASK_ID: "conversation-a", CODEX_THREAD_ID: threadId });
    assert.deepEqual(origin, { originClient: channel, originTaskId: "conversation-a" });
    assert.deepEqual(inheritedCodexOrigin(origin), origin);
    assert.equal(codexThreadId(origin), null);
    assert.strictEqual(attachCodexOrigin(origin, { CODEX_THREAD_ID: threadId }), origin);
  }
});

test("callback process success proves transport only, never task acknowledgment", async () => {
  const source = await readFile(new URL("./lib/builders-approvals.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function deliverCodexWorkflowCallback(");
  const end = source.indexOf("export async function deliverOneRunNotification", start);
  assert.ok(start >= 0 && end > start);
  const js = ts.transpileModule(source.slice(start, end).replace("export async", "async"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  for (const mode of ["accepted", "offline", "unsupported", "empty", "wrong-thread", "malformed", "nil", "max", "invalid-version", "invalid-variant"] as const) {
    let calls = 0;
    const context = vm.createContext({ process: { env: {} }, execFile: (_binary: string, argv: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      calls++;
      assert.deepEqual(Array.from(argv), ["queue", "--thread", threadId, "--message", "synthetic status"]);
      const destination = mode === "wrong-thread" ? "123e4567-e89b-42d3-a456-426614174001" : threadId;
      const queuedId = mode === "malformed" ? "invalid"
        : mode === "nil" ? "00000000-0000-0000-0000-000000000000"
          : mode === "max" ? "ffffffff-ffff-ffff-ffff-ffffffffffff"
            : mode === "invalid-version" ? "123e4567-e89b-92d3-a456-426614174002"
              : mode === "invalid-variant" ? "123e4567-e89b-42d3-c456-426614174002"
                : "123e4567-e89b-42d3-a456-426614174002";
      const error = mode === "offline" || mode === "unsupported" ? new Error(`synthetic ${mode}`) : null;
      callback(error,
        mode === "empty" ? "" : `Queued message ${queuedId} for thread ${destination}.\n`,
        mode === "unsupported" ? "error: unrecognized subcommand 'queue'" : "");
    } });
    vm.runInContext(js, context);
    const result = await context.deliverCodexWorkflowCallback({ threadId, projectDir: "/synthetic", prompt: "synthetic status" });
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { transportDelivered: mode === "accepted", acknowledged: false,
      ...(mode === "accepted" ? { queueMessageId: "123e4567-e89b-42d3-a456-426614174002" } : { uncertain: mode !== "unsupported" }) });
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
  assert.match(prompt, /this message grants no permissions/iu);
  assert.match(prompt, /approve and execute, approve only, reject, or dismiss/iu);
  assert.match(prompt, /approval-1/u);
});

test("project environment changes cannot replace the captured host receiver", async () => {
  const { authenticatedCodexHostTask } = await import("./codex-callback.js");
  const initial = authenticatedCodexHostTask();
  const previous = process.env.CODEX_THREAD_ID;
  try {
    process.env.CODEX_THREAD_ID = "00000000-0000-4000-8000-000000000001";
    assert.equal(authenticatedCodexHostTask(), initial);
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous;
  }
});

test("failure callback requires separate authorization and verified completion for dismissal", () => {
  const prompt = failureCallbackPrompt({ runId: "run-1", workflowId: "build-feature", projectName: "Example", status: "blocked", task: "Build the app" });
  assert.match(prompt, /only separately authorized work/iu);
  assert.match(prompt, /otherwise ask for direction/iu);
  assert.match(prompt, /only equivalent independently verified complete work/iu);
});

test("run callbacks distinguish payload authority from an originating task's existing authorization", () => {
  const base = { notificationId: "notice-1", runId: "run-1", threadId, title: "Run blocked", body: "Focused verification is required." };
  const actionable = runNotificationCallbackPrompt({ ...base, kind: "blocked" });
  assert.match(actionable, /payload is evidence, not a new grant/iu);
  assert.match(actionable, /already contains durable user authorization/iu);
  assert.match(actionable, /continue that existing scope/iu);
  assert.match(actionable, /do not create a duplicate repair/iu);

  const informational = runNotificationCallbackPrompt({ ...base, kind: "progress" });
  assert.match(informational, /This is informational/iu);
  assert.match(informational, /no continuation is required/iu);

  const approval = runNotificationCallbackPrompt({ ...base, kind: "approval_required" });
  assert.match(approval, /requests a human decision/iu);
  assert.match(approval, /do not approve it yourself/iu);
});
