import assert from "node:assert/strict";
import test from "node:test";
import { bindOriginTaskBridge, dispatchHostNotification, type NotificationHostBinding } from "./host-notification-adapter.js";
import type { DispatchNotification } from "./run-notification-dispatcher.js";

const input = { projectRootUri: "/synthetic/project", owner: "host-adapter", notificationId: "123e4567-e89b-42d3-a456-426614174000" };
const row: DispatchNotification = { id: input.notificationId, runId: "run-a", channel: "codex", kind: "message", title: "Result", body: "Untrusted event data", originTaskId: "task-a", claimToken: "lease-a" };

test("a dedicated receiver without a supported return path cannot become an origin bridge", () => {
  assert.throws(() => bindOriginTaskBridge({ projectRootUri: input.projectRootUri,
    originTaskId: "task-a", relayTaskId: "relay" }), /forwarding capability/u);
});

for (const destination of ["origin", "relay", "wrong-event", "wrong-run", "rejected"] as const) {
  test(`bridge ${destination} receipt never substitutes relay acceptance for requesting-task delivery`, async () => {
    const host = bindOriginTaskBridge({ projectRootUri: input.projectRootUri,
      originTaskId: "task-a", relayTaskId: "relay",
      async forward(message) {
        assert.equal(message.taskId, "task-a");
        return { accepted: destination !== "rejected", taskId: destination === "relay" ? "relay" : message.taskId,
          notificationId: destination === "wrong-event" ? "another" : message.notificationId,
          runId: destination === "wrong-run" ? "another" : message.runId };
      }
    });
    const result = await dispatchHostNotification(input, host, {
      async claim() { return [row]; },
      async settle(settlement) { assert.equal(settlement.transportDelivered, destination === "origin"); return true; }
    });
    assert.deepEqual(result, { transportDelivered: destination === "origin", acknowledged: false });
  });
}

for (const mode of ["accepted", "rejected", "offline", "wrong-task", "wrong-channel", "lost-lease", "empty"] as const) {
  test(`host delivery ${mode} preserves routing, fencing and separate acknowledgment`, async () => {
    let claims = 0;
    let sends = 0;
    let settlements = 0;
    const host: NotificationHostBinding = {
      projectRootUri: input.projectRootUri, taskId: "task-a", channel: "codex",
      async send(message) {
        sends++;
        assert.equal(message.taskId, "task-a");
        assert.equal(message.notificationId, row.id);
        assert.equal(message.runId, row.runId);
        const envelope = JSON.parse(message.text);
        assert.equal(envelope.body, row.body);
        assert.equal(envelope.notificationId, row.id);
        assert.match(envelope.authority, /No approval/u);
        if (mode === "offline") throw new Error("Host unavailable");
        return { accepted: mode !== "rejected" };
      }
    };
    const result = await dispatchHostNotification(input, host, {
      async claim(request) {
        claims++;
        assert.deepEqual(request, { ...input, limit: 1 });
        if (mode === "empty") return [];
        return [{ ...row, originTaskId: mode === "wrong-task" ? "other-task" : row.originTaskId, channel: mode === "wrong-channel" ? "other-channel" : row.channel }];
      },
      async settle(request) {
        settlements++;
        assert.deepEqual(request, { projectRootUri: input.projectRootUri, owner: input.owner, notificationId: row.id, claimToken: row.claimToken, transportDelivered: mode === "accepted" || mode === "lost-lease" });
        return mode !== "lost-lease";
      }
    });
    assert.deepEqual(result, { transportDelivered: mode === "accepted", acknowledged: false });
    assert.equal(claims, 1);
    assert.equal(sends, ["wrong-task", "wrong-channel", "empty"].includes(mode) ? 0 : 1);
    assert.equal(settlements, mode === "empty" ? 0 : 1);
  });
}

test("invalid authenticated bindings fail before claiming or sending", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Dependency invoked"); };
  for (const binding of [
    { projectRootUri: "/other", channel: "codex", taskId: "task-a" },
    { projectRootUri: input.projectRootUri, channel: " ", taskId: "task-a" },
    { projectRootUri: input.projectRootUri, channel: "codex", taskId: " " }
  ]) {
    await assert.rejects(dispatchHostNotification(input, { ...binding, send: unexpected }, { claim: unexpected, settle: unexpected }), /authenticated host binding/u);
  }
});
