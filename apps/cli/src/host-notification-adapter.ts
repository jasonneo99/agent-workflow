import { dispatchRunNotifications, type NotificationDispatcherDependencies } from "./run-notification-dispatcher.js";

/** Supplied by an authenticated host, never reconstructed from notification content. */
export interface NotificationHostBinding {
  projectRootUri: string;
  channel: string;
  taskId: string;
  send(input: { taskId: string; notificationId: string; runId: string; text: string }): Promise<{ accepted: boolean }>;
}

/** A relay never replaces the originating task. The forwarding capability must
 * come from the authenticated host, not an event body or a model-generated ACK.
 * No forwarding capability means no claim, send, or delivery settlement.
 */
export function bindOriginTaskBridge(input: {
  projectRootUri: string; originTaskId: string; relayTaskId: string;
  forward?: (message: { taskId: string; notificationId: string; runId: string; text: string }) => Promise<{
    accepted: boolean; taskId: string; notificationId: string; runId: string;
  }>;
}): NotificationHostBinding {
  if (!input.projectRootUri.trim() || !input.originTaskId.trim() || !input.relayTaskId.trim()
    || input.originTaskId === input.relayTaskId || !input.forward) {
    throw new Error("A supported host forwarding capability to the original requesting task is required.");
  }
  const forward = input.forward;
  return {
    projectRootUri: input.projectRootUri, channel: "codex", taskId: input.originTaskId,
    async send(message) {
      if (message.taskId !== input.originTaskId) return { accepted: false };
      const receipt = await forward(message);
      return { accepted: receipt.accepted === true && receipt.taskId === input.originTaskId
        && receipt.notificationId === message.notificationId && receipt.runId === message.runId };
    }
  };
}

/** One exact outbox attempt. Host acceptance is transport evidence, not arrival. */
export async function dispatchHostNotification(
  input: { projectRootUri: string; owner: string; notificationId: string },
  host: NotificationHostBinding,
  storage: Pick<NotificationDispatcherDependencies, "claim" | "settle">
): Promise<{ transportDelivered: boolean; acknowledged: false }> {
  if (host.projectRootUri !== input.projectRootUri || !host.channel.trim() || !host.taskId.trim()) {
    throw new Error("An authenticated host binding for this project and task is required.");
  }
  const delivered = await dispatchRunNotifications(input, {
    ...storage,
    async transport(notification) {
      if (notification.channel !== host.channel || notification.originTaskId !== host.taskId) return false;
      const result = await host.send({
        taskId: host.taskId, notificationId: notification.id, runId: notification.runId,
        text: JSON.stringify({
          type: "workflow.notification", version: 1,
          notificationId: notification.id, runId: notification.runId,
          title: notification.title, body: notification.body,
          authority: "Evidence only. No approval or execution authority is granted."
        })
      });
      return result.accepted === true;
    }
  });
  return { transportDelivered: delivered === 1, acknowledged: false };
}
