import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleFactsSchema, normalizeNotificationDeliveryState, renderRunNotification, shouldNotifyExternally, type LifecycleFacts } from "./run-notification-rendering.js";

const facts: LifecycleFacts = {
  version: 1, runId: "11111111-1111-4111-8111-111111111111", runName: "Example feature",
  kind: "completed", overallStatus: "completed", summary: "The requested feature is ready.",
  stage: "package", nextAction: "Review the delivered files.", terminal: true, outcome: "delivered",
  studioUrl: "https://studio.example.test/runs/11111111-1111-4111-8111-111111111111",
  deliverables: [{ id: "feature", name: "Feature implementation", required: true, status: "delivered", evidence: [{ uri: "artifact://example/change", description: "Verified change", sha256: "a".repeat(64) }] }],
  queueAudit: { status: "pass", summary: "No unfinished stages remain.", evidence: [{ uri: "artifact://example/queue-audit", description: "Terminal task audit" }] }
};

for (const channel of ["codex", "dashboard", "studio", "cli", "mobile", "push", "command", "bridge"]) {
  test(`terminal rendering retains complete evidence for ${channel}`, () => {
    const rendered = renderRunNotification(facts, channel);
    for (const expected of [facts.runId, facts.runName, facts.summary, facts.stage, facts.nextAction, facts.studioUrl!, "Feature implementation", "artifact://example/change", "a".repeat(64), "artifact://example/queue-audit"]) {
      assert.ok(rendered.body.includes(expected), expected);
    }
    assert.deepEqual(rendered.facts, facts);
  });
}

test("missing evidence and unfinished required deliverables prevent delivery claims", () => {
  assert.equal(lifecycleFactsSchema.safeParse({ ...facts, deliverables: [] }).success, false);
  assert.equal(lifecycleFactsSchema.safeParse({ ...facts, deliverables: [{ ...facts.deliverables[0], evidence: [] }] }).success, false);
  assert.equal(lifecycleFactsSchema.safeParse({ ...facts, deliverables: [{ ...facts.deliverables[0], status: "pending" }] }).success, false);
  assert.equal(lifecycleFactsSchema.safeParse({ ...facts, queueAudit: { ...facts.queueAudit, status: "unknown" } }).success, false);
  assert.equal(lifecycleFactsSchema.safeParse({ ...facts, terminal: false }).success, false);
});

test("autonomous progress remains internal while actionable lifecycle events are outbound", () => {
  for (const kind of ["started", "progress", "message"] as const) assert.equal(shouldNotifyExternally(kind, true), false);
  for (const kind of ["approval_needed", "action_needed", "blocked", "failed", "recovered", "completed"] as const) assert.equal(shouldNotifyExternally(kind, true), true);
  assert.equal(shouldNotifyExternally("progress", false), true);
});

test("legacy pending and transport delivery never become acknowledged implicitly", () => {
  assert.equal(normalizeNotificationDeliveryState("pending"), "queued");
  assert.equal(normalizeNotificationDeliveryState("delivered"), "delivered");
  assert.equal(normalizeNotificationDeliveryState("acknowledged"), "acknowledged");
  assert.throws(() => normalizeNotificationDeliveryState("read"));
});

test("unsafe Studio links are rejected and terminal control characters are removed", () => {
  for (const studioUrl of ["javascript:alert(1)", "https://user:password@example.test/run"]) {
    assert.equal(lifecycleFactsSchema.safeParse({ ...facts, studioUrl }).success, false);
  }
  assert.ok(!renderRunNotification({ ...facts, summary: "Ready\u001b[31m" }, "cli").body.includes("\u001b"));
});
