import assert from "node:assert/strict";
import test from "node:test";
import { createDevSessionApproval } from "../../../../packages/storage/src/dev-sessions.js";
import {
  createDevSessionFromBody,
  decideDevSessionApprovalFromBody,
  formatDevSseEvent,
  getDevSessionDetail,
  parseDevSessionPath
} from "./dev-session-routes.js";

test("dev session path parsing accepts only session ids with an optional action", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(parseDevSessionPath(`/api/dev-session/${id}`), { id, action: "" });
  assert.deepEqual(parseDevSessionPath(`/api/dev-session/${id}/message`), { id, action: "message" });
  assert.equal(parseDevSessionPath("/api/dev-session/not-a-uuid"), null);
  assert.equal(parseDevSessionPath("/api/dev-session"), null);
  assert.equal(parseDevSessionPath(`/api/dev-session/${id}/message/extra`), null);
});

test("dev SSE events are formatted as named events with JSON data", () => {
  const formatted = formatDevSseEvent({ type: "token", turnId: "turn-1", text: "hello" });
  assert.equal(formatted, `event: token\ndata: ${JSON.stringify({ type: "token", turnId: "turn-1", text: "hello" })}\n\n`);
});

test("creating a dev session validates the project and provider before persisting", async () => {
  const { session } = await createDevSessionFromBody({ project: "templates/project", provider: "mock", title: "Route test" });
  assert.equal(session.provider, "mock");
  assert.equal(session.policyProfile, "trusted-personal");
  assert.match(session.projectRootUri, /templates\/project$/u);

  const detail = await getDevSessionDetail(session.id);
  assert.equal(detail.session.id, session.id);
  assert.deepEqual(detail.turns, []);
  assert.deepEqual(detail.diffs, []);

  await assert.rejects(createDevSessionFromBody({ project: "templates/project", provider: "no-such-provider" }), /Unsupported provider adapter/);
  await assert.rejects(createDevSessionFromBody({ project: "does/not/exist" }), /Unknown project directory/);
  await assert.rejects(createDevSessionFromBody({}), /Missing project/);
});

test("deciding a dev approval records the decision and returns a resume hint when approved", async () => {
  const { session } = await createDevSessionFromBody({ project: "templates/project", provider: "mock", title: "Approval route test" });
  const approval = await createDevSessionApproval({
    sessionId: session.id,
    turnId: null,
    actionType: "local_command",
    target: 'python3 -c "print(1)"',
    rationale: "Test approval.",
    policyDecision: { approvalRequired: true },
    payload: {},
    idempotencyKey: "route-test-approval-1"
  });
  const decided = await decideDevSessionApprovalFromBody({
    sessionId: session.id,
    body: { approvalId: approval.id, decision: "approved", actor: "test-user" }
  });
  assert.equal(decided.approval?.status, "approved");
  assert.match(decided.resumeHint ?? "", /Continue with the approved local_command/);

  const detail = await getDevSessionDetail(session.id);
  assert.equal(detail.approvals.length, 1);
  assert.equal(detail.approvals[0].status, "approved");

  await assert.rejects(
    decideDevSessionApprovalFromBody({ sessionId: session.id, body: { approvalId: approval.id, decision: "rejected" } }),
    /already decided/
  );
  await assert.rejects(
    decideDevSessionApprovalFromBody({ sessionId: session.id, body: { approvalId: "00000000-0000-0000-0000-000000000000", decision: "approved" } }),
    /Unknown dev approval/
  );
  await assert.rejects(
    decideDevSessionApprovalFromBody({ sessionId: session.id, body: { approvalId: approval.id, decision: "maybe" } }),
    /approved or rejected/
  );
});
