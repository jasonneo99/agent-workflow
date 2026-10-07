import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { consumeHostNotification, createWebhookHost, verifyNotificationSignature } from "./notification-webhook.js";

test("real loopback receiver verifies signatures, rejects busy delivery, then accepts retry", async () => {
  const secret = randomBytes(32).toString("hex");
  let received = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const proof = { body, secret, timestamp: String(request.headers["x-agentflow-timestamp"]), signature: String(request.headers["x-agentflow-signature"]) };
    assert.equal(verifyNotificationSignature(proof), true);
    assert.equal(verifyNotificationSignature({ ...proof, body: body + " " }), false);
    assert.equal(verifyNotificationSignature({ ...proof, now: Date.now() + 600_000 }), false);
    received++;
    response.writeHead(received === 1 ? 503 : 204).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const host = createWebhookHost({ projectRootUri: "/synthetic", channel: "test", taskId: "client-a", endpoint: `http://127.0.0.1:${address.port}`, secret, allowLoopbackHttp: true });
    const settlements: boolean[] = [];
    const result = await consumeHostNotification({ projectRootUri: "/synthetic", owner: "test-consumer", notificationId: "123e4567-e89b-42d3-a456-426614174000", maxChecks: 3, intervalMs: 100, signal: new AbortController().signal }, host, {
      async claim() { return [{ id: "123e4567-e89b-42d3-a456-426614174000", runId: "run-a", channel: "test", kind: "completed", title: "Result", body: "Synthetic result", originTaskId: "client-a", claimToken: "synthetic-lease" }]; },
      async settle(input) { settlements.push(input.transportDelivered); return true; }
    });
    assert.deepEqual(settlements, [false, true]);
    assert.equal(received, 2);
    assert.deepEqual(result, { transportDelivered: true, acknowledged: false, checks: 2 });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("consumer stops while offline and can restart without claiming arrival", async () => {
  const controller = new AbortController();
  let claims = 0;
  const input = { projectRootUri: "/synthetic", owner: "test", notificationId: "123e4567-e89b-42d3-a456-426614174000", maxChecks: 3, intervalMs: 100, signal: controller.signal };
  const host = { projectRootUri: "/synthetic", channel: "test", taskId: "client", async send() { throw Error("offline"); } };
  const storage = { async claim() { claims++; controller.abort(); return []; }, async settle() { return true; } };
  assert.deepEqual(await consumeHostNotification(input, host, storage), { transportDelivered: false, acknowledged: false, checks: 1 });
  assert.equal(claims, 1);
  assert.deepEqual(await consumeHostNotification({ ...input, maxChecks: 1, signal: new AbortController().signal }, host, storage), { transportDelivered: false, acknowledged: false, checks: 1 });
  assert.equal(claims, 2);
});

test("webhook configuration and signature validation fail closed", () => {
  const base = { projectRootUri: "/synthetic", channel: "test", taskId: "client", secret: "s".repeat(32) };
  for (const endpoint of ["http://example.com", "http://127.0.0.1", "https://user:pass@example.com", "https://example.com/#fragment", "file:///tmp/socket"]) {
    assert.throws(() => createWebhookHost({ ...base, endpoint }), /Webhook/u);
  }
  assert.throws(() => createWebhookHost({ ...base, endpoint: "https://example.com", secret: "short" }), /Webhook/u);
  assert.equal(verifyNotificationSignature({ body: "{}", timestamp: "invalid", signature: "invalid", secret: base.secret }), false);
});
