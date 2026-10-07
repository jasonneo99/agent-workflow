import type { IncomingMessage, ServerResponse } from "node:http";
import { acknowledgeSubscriberNotification } from "../../../packages/storage/src/notification-subscribers.js";

/** This route authenticates a receiver credential, not a general server actor. */
export async function handleNotificationAcknowledgment(request: IncomingMessage, response: ServerResponse,
  acknowledge = acknowledgeSubscriberNotification): Promise<void> {
  const reply = (status: number, acknowledged = false): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ acknowledged }));
  };
  const authorization = request.headers.authorization ?? "";
  if (!/^Bearer [a-f0-9]{64}$/u.test(authorization)) { reply(403); return; }
  let parsed = false;
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) { reply(413); return; }
    }
    const value = JSON.parse(body);
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => key !== "notificationId" && key !== "runId")
      || typeof value.notificationId !== "string" || typeof value.runId !== "string"
      || !uuid.test(value.notificationId) || !uuid.test(value.runId)) { reply(400); return; }
    parsed = true;
    const accepted = await acknowledge({ token: authorization.slice(7), notificationId: value.notificationId, runId: value.runId });
    reply(accepted ? 200 : 403, accepted);
  } catch { reply(parsed ? 503 : 400); }
}
