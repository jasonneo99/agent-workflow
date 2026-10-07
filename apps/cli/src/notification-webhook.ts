import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dispatchHostNotification, type NotificationHostBinding } from "./host-notification-adapter.js";
import type { NotificationDispatcherDependencies } from "./run-notification-dispatcher.js";

function signature(body: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Verify exact bytes before parsing; receivers must additionally dedupe notification IDs. */
export function verifyNotificationSignature(input: {
  body: string; timestamp: string; signature: string; secret: string; now?: number;
}): boolean {
  if (Buffer.byteLength(input.secret) < 32 || Buffer.byteLength(input.body) > 262144
    || !/^\d{10,13}$/u.test(input.timestamp) || !/^[a-f0-9]{64}$/u.test(input.signature)) return false;
  if (Math.abs((input.now ?? Date.now()) - Number(input.timestamp)) > 300_000) return false;
  return timingSafeEqual(Buffer.from(signature(input.body, input.timestamp, input.secret), "hex"), Buffer.from(input.signature, "hex"));
}

/** Trusted configuration only: never accept a destination or secret from event data.
 * Exact endpoint approval is the deployment boundary. Redirects are never followed.
 */
export function createWebhookHost(input: {
  projectRootUri: string; channel: string; taskId: string; endpoint: string;
  secret: string; allowLoopbackHttp?: boolean;
}): NotificationHostBinding {
  const endpoint = new URL(input.endpoint);
  const loopback = ["127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.hash
    || !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback && input.allowLoopbackHttp))
    || Buffer.byteLength(input.secret) < 32) throw new Error("Webhook requires an approved secure endpoint and at least 32 secret bytes.");
  return {
    projectRootUri: input.projectRootUri, channel: input.channel, taskId: input.taskId,
    async send(message) {
      if (message.taskId !== input.taskId || Buffer.byteLength(message.text) > 262144) return { accepted: false };
      const timestamp = String(Date.now());
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-agentflow-timestamp": timestamp,
          "x-agentflow-signature": signature(message.text, timestamp, input.secret) },
        body: message.text
      });
      // Drain no unbounded response body. HTTP acceptance still does not prove client arrival.
      await response.body?.cancel();
      return { accepted: response.status >= 200 && response.status < 300 };
    }
  };
}

/** Bounded, serial background consumption of one explicitly selected notification.
 * Storage owns persistence, backoff and claim fencing across consumer restarts.
 */
export async function consumeHostNotification(input: {
  projectRootUri: string; owner: string; notificationId: string;
  maxChecks: number; intervalMs: number; signal: AbortSignal;
}, host: NotificationHostBinding, storage: Pick<NotificationDispatcherDependencies, "claim" | "settle">): Promise<{ transportDelivered: boolean; acknowledged: false; checks: number }> {
  if (!Number.isInteger(input.maxChecks) || input.maxChecks < 1 || input.maxChecks > 100
    || !Number.isInteger(input.intervalMs) || input.intervalMs < 100 || input.intervalMs > 60_000) throw new Error("Invalid bounded consumer configuration.");
  let checks = 0;
  while (checks < input.maxChecks && !input.signal.aborted) {
    checks++;
    const result = await dispatchHostNotification(input, host, storage);
    if (result.transportDelivered) return { ...result, checks };
    try { if (checks < input.maxChecks) await delay(input.intervalMs, undefined, { signal: input.signal }); }
    catch (error) { if (!input.signal.aborted) throw error; }
  }
  return { transportDelivered: false, acknowledged: false, checks };
}
