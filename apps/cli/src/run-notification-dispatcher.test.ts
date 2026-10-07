import assert from "node:assert/strict";
import test from "node:test";
import { dispatchRunNotifications, type DispatchNotification, type NotificationDispatcherDependencies } from "./run-notification-dispatcher.js";

const scope = { projectRootUri: "/synthetic/project-a", owner: "synthetic-dispatcher" };
const notification: DispatchNotification = {
  id: "notification-a", runId: "run-a", channel: "codex", kind: "blocked",
  title: "Synthetic attention", body: "Inspect evidence only.",
  originTaskId: "123e4567-e89b-42d3-a456-426614174000", claimToken: "claim-a"
};

for (const mode of ["success", "offline", "throws", "lost-claim"] as const) {
  test(`dispatcher settles ${mode} with correlated project and claim identities`, async () => {
    const events: string[] = [];
    let claims = 0;
    const count = await dispatchRunNotifications(scope, {
      async claim(input) {
        events.push("claim");
        assert.deepEqual(input, { ...scope, limit: 1 });
        return claims++ === 0 ? [notification] : [];
      },
      async transport(value) {
        events.push("transport");
        assert.strictEqual(value, notification);
        if (mode === "throws") throw new Error("Synthetic offline transport");
        return mode !== "offline";
      },
      async settle(input) {
        events.push("settle");
        assert.deepEqual(input, {
          ...scope, notificationId: notification.id, claimToken: notification.claimToken,
          transportDelivered: mode === "success" || mode === "lost-claim"
        });
        return mode !== "lost-claim";
      }
    });
    assert.equal(count, mode === "success" ? 1 : 0);
    assert.deepEqual(events, mode === "lost-claim"
      ? ["claim", "transport", "settle"]
      : ["claim", "transport", "settle", "claim"]);
  });
}

test("storage settlement failure stops dispatch before another transport", async () => {
  let claims = 0;
  let sends = 0;
  await assert.rejects(dispatchRunNotifications(scope, {
    async claim() { claims += 1; return [notification]; },
    async transport() { sends += 1; return true; },
    async settle() { throw new Error("Synthetic storage failure"); }
  }), /storage failure/u);
  assert.equal(claims, 1);
  assert.equal(sends, 1);
});

test("invalid scopes and limits fail before invoking dependencies", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Dependency invoked"); };
  const dependencies: NotificationDispatcherDependencies = {
    claim: unexpected, transport: unexpected, settle: unexpected
  };
  for (const input of [
    { ...scope, projectRootUri: " " }, { ...scope, owner: " " },
    { ...scope, limit: 0 }, { ...scope, limit: 51 }, { ...scope, limit: NaN }
  ]) {
    await assert.rejects(dispatchRunNotifications(input, dependencies), /explicit project|integer between/u);
  }
});

test("bounded dispatch settles each claim before acquiring the next", async () => {
  let outstanding = false;
  let claims = 0;
  const count = await dispatchRunNotifications({ ...scope, limit: 2 }, {
    async claim(input) {
      assert.equal(outstanding, false);
      assert.equal(input.limit, 1);
      outstanding = true;
      claims += 1;
      return [{ ...notification, claimToken: `claim-${claims}` }];
    },
    async transport() { assert.equal(outstanding, true); return true; },
    async settle() { assert.equal(outstanding, true); outstanding = false; return true; }
  });
  assert.equal(count, 2);
  assert.equal(claims, 2);
  assert.equal(outstanding, false);
});

test("an oversized storage claim fails closed before transport", async () => {
  let sends = 0;
  await assert.rejects(dispatchRunNotifications(scope, {
    async claim() { return [notification, notification]; },
    async transport() { sends += 1; return true; },
    async settle() { return true; }
  }), /exceeded/u);
  assert.equal(sends, 0);
});

test("exact selection makes at most one attempt even when transport fails", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const success of [true, false]) {
    let claims = 0;
    let sends = 0;
    let settlements = 0;
    assert.equal(await dispatchRunNotifications({ ...scope, notificationId: id }, {
      async claim(input) { claims++; assert.equal(input.notificationId, id); return [{ ...notification, id }]; },
      async transport() { sends++; return success; },
      async settle(input) { settlements++; assert.equal(input.transportDelivered, success); return true; }
    }), success ? 1 : 0);
    assert.deepEqual([claims, sends, settlements], [1, 1, 1]);
  }
});

test("exact selection never sends an unrelated claim and validates before claim", async () => {
  let claims = 0;
  const dependencies: NotificationDispatcherDependencies = {
    async claim() { claims++; return [notification]; },
    async transport() { assert.fail("Unexpected transport"); },
    async settle() { assert.fail("Unexpected settlement"); }
  };
  await assert.rejects(dispatchRunNotifications({ ...scope, notificationId: "" }, dependencies), /Invalid notification/u);
  assert.equal(claims, 0);
  await assert.rejects(dispatchRunNotifications({ ...scope, notificationId: "00000000-0000-4000-8000-000000000001" }, dependencies), /did not match/u);
  assert.equal(claims, 1);
});
