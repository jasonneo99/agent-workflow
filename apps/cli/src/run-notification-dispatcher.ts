export interface DispatchNotification {
  id: string;
  runId: string;
  channel: string;
  kind: string;
  title: string;
  body: string;
  originTaskId: string | null;
  claimToken: string;
}

export interface NotificationDispatcherDependencies {
  claim(input: { projectRootUri: string; owner: string; limit: number }): Promise<DispatchNotification[]>;
  transport(notification: DispatchNotification): Promise<boolean>;
  settle(input: {
    projectRootUri: string; owner: string; notificationId: string;
    claimToken: string; transportDelivered: boolean;
  }): Promise<boolean>;
}

/** Transport completion never proves originating-task acknowledgment or grants action authority. */
export async function dispatchRunNotifications(
  input: { projectRootUri: string; owner: string; limit?: number },
  dependencies: NotificationDispatcherDependencies
): Promise<number> {
  if (!input.projectRootUri.trim() || !input.owner.trim()) {
    throw new Error("Notification dispatch requires an explicit project and owner.");
  }
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Notification dispatch limit must be an integer between 1 and 50.");
  }
  let delivered = 0;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    // Avoid expiring later claims while an earlier transport is busy.
    const notifications = await dependencies.claim({
      projectRootUri: input.projectRootUri, owner: input.owner, limit: 1
    });
    if (!notifications.length) break;
    if (notifications.length !== 1) throw new Error("Notification claim exceeded its requested bound.");
    const notification = notifications[0];
    let transportDelivered = false;
    try {
      transportDelivered = await dependencies.transport(notification);
    } catch {
      // Offline and busy errors must settle as failures so storage schedules retry.
    }
    const settled = await dependencies.settle({
      projectRootUri: input.projectRootUri,
      owner: input.owner,
      notificationId: notification.id,
      claimToken: notification.claimToken,
      transportDelivered
    });
    if (!settled) break;
    if (transportDelivered) delivered += 1;
  }
  return delivered;
}
