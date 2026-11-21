import assert from "node:assert/strict";
import test from "node:test";
import {
  addDevSessionTurn,
  appendDevSessionReceipt,
  createDevSession,
  getDevSession,
  getDevSessionDiff,
  listDevSessionDiffs,
  listDevSessionReceipts,
  listDevSessionTurns,
  listDevSessions,
  setDevSessionDiffDecision,
  updateDevSessionTurn,
  upsertDevSessionDiff,
  verifyDevSessionReceiptChain
} from "./dev-sessions.js";

const projectRootUri = "/tmp/agent-workflow-dev-session-test-project";

test("dev sessions persist with turns and a hash-chained receipt chain", async () => {
  const session = await createDevSession({ projectRootUri, provider: "mock", title: "Test session" });
  assert.equal(session.projectRootUri, projectRootUri);
  assert.equal(session.provider, "mock");
  assert.equal(session.policyProfile, "trusted-personal");
  assert.equal(session.status, "active");

  const fetched = await getDevSession(session.id);
  assert.equal(fetched?.id, session.id);
  assert.equal(await getDevSession("00000000-0000-0000-0000-000000000000"), null);

  const listed = await listDevSessions({ projectRootUri });
  assert.ok(listed.some((item) => item.id === session.id));

  const userTurn = await addDevSessionTurn({ sessionId: session.id, role: "user", content: "Hello", status: "completed" });
  const assistantTurn = await addDevSessionTurn({ sessionId: session.id, role: "assistant", content: "", status: "running" });
  const updated = await updateDevSessionTurn(assistantTurn.id, { content: "Hi there", status: "completed" });
  assert.equal(updated?.content, "Hi there");
  assert.equal(updated?.status, "completed");
  const turns = await listDevSessionTurns(session.id);
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ["user", "assistant"]
  );
  assert.equal(turns[0].id, userTurn.id);

  await appendDevSessionReceipt({
    sessionId: session.id,
    turnId: assistantTurn.id,
    agentId: "dev-mode-agent",
    actionType: "dev_turn_started",
    target: userTurn.id,
    summary: "Turn started.",
    metadata: { provider: "mock" }
  });
  await appendDevSessionReceipt({
    sessionId: session.id,
    turnId: assistantTurn.id,
    agentId: "dev-mode-agent",
    actionType: "dev_turn_completed",
    target: assistantTurn.id,
    summary: "Turn completed.",
    metadata: {}
  });
  const receipts = await listDevSessionReceipts(session.id);
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].receiptHash, receipts[1].receiptHash);
  assert.equal(receipts[1].prevHash, receipts[0].receiptHash);

  const verification = await verifyDevSessionReceiptChain(session.id);
  assert.equal(verification.valid, true);
  assert.equal(verification.checked, 2);

  await assert.rejects(
    appendDevSessionReceipt({
      sessionId: "00000000-0000-0000-0000-000000000000",
      agentId: "dev-mode-agent",
      actionType: "dev_turn_started",
      target: "x",
      summary: "No session.",
      metadata: {}
    }),
    /Cannot append a receipt without its dev session/
  );
});

test("dev session diffs are proposed and decided once", async () => {
  const session = await createDevSession({ projectRootUri, provider: "mock", title: "Diff session" });
  const turn = await addDevSessionTurn({ sessionId: session.id, role: "assistant", content: "done", status: "completed" });
  const diff = await upsertDevSessionDiff({
    sessionId: session.id,
    turnId: turn.id,
    path: "src/example.ts",
    originalHash: "abc",
    proposedContent: "export const x = 1;\n",
    diffText: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n",
    payloadHash: "def"
  });
  assert.equal(diff.status, "proposed");
  const diffs = await listDevSessionDiffs(session.id);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, "src/example.ts");

  const decided = await setDevSessionDiffDecision({ diffId: diff.id, status: "accepted", decidedBy: "dashboard-user" });
  assert.equal(decided?.status, "accepted");
  assert.equal(decided?.decidedBy, "dashboard-user");
  // A decided diff cannot be decided again.
  assert.equal(await setDevSessionDiffDecision({ diffId: diff.id, status: "rejected", decidedBy: "dashboard-user" }), null);
  assert.equal((await getDevSessionDiff(diff.id))?.status, "accepted");
});
