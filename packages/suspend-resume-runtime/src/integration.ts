import type { SliceReceipt, SliceReceiptSink, ThreadInputQueue, ToolCall } from "./index.js";

export type AuthorityDecision =
  | { effect: "execute"; authorityId: string }
  | { effect: "approval_required"; approvalId: string }
  | { effect: "deny"; reason: string };

export interface RuntimeAuthorityPort {
  authorize(input: { runId: string; threadId: string; toolCall: ToolCall }): Promise<AuthorityDecision>;
}

export interface RuntimeExecutorPort {
  /** Starts governed execution and returns after durable acceptance. */
  start(input: { runId: string; threadId: string; toolCall: ToolCall; authorityId: string; resultEventId: string }): Promise<void>;
}

export interface RuntimeApprovalPort {
  /** Uses the existing approval outbox; the runtime does not create a parallel approval queue. */
  request(input: { runId: string; threadId: string; toolCall: ToolCall; approvalId: string; resultEventId: string }): Promise<void>;
}

export interface RuntimeReceiptPort {
  append(input: Omit<SliceReceipt, "sequence">): Promise<void>;
}

export class ExistingReceiptChainSink implements SliceReceiptSink {
  constructor(private readonly port: RuntimeReceiptPort) {}
  record(receipt: Omit<SliceReceipt, "sequence">): Promise<void> { return this.port.append(receipt); }
}

/** Bridges bounded slices into the current executor and approval machinery.
 * Policy decides before either side effect. Execution completion and approval
 * decisions return through the input queue with stable event IDs. */
export class GovernedRuntimeDispatcher {
  constructor(private readonly dependencies: {
    runId: string;
    authority: RuntimeAuthorityPort;
    executor: RuntimeExecutorPort;
    approvals: RuntimeApprovalPort;
  }) {}

  async dispatch(input: { threadId: string; toolCall: ToolCall }): Promise<void> {
    const decision = await this.dependencies.authority.authorize({ runId: this.dependencies.runId, ...input });
    const resultEventId = `tool-result:${input.toolCall.id}`;
    if (decision.effect === "deny") throw new Error(`Tool dispatch denied: ${decision.reason}`);
    if (decision.effect === "approval_required") {
      await this.dependencies.approvals.request({ runId: this.dependencies.runId, ...input, approvalId: decision.approvalId, resultEventId });
      return;
    }
    await this.dependencies.executor.start({ runId: this.dependencies.runId, ...input, authorityId: decision.authorityId, resultEventId });
  }
}

export interface RunNotificationAcknowledgmentPort {
  /** Enqueues to the existing run_notifications outbox and returns its identity. */
  enqueue(input: { runId: string; eventKey: string; title: string; body: string }): Promise<string>;
  /** True only after authenticated originating-task arrival, never transport exit. */
  isAcknowledged(notificationId: string): Promise<boolean>;
}

/** DF-RESTART-01A remains authoritative for delivery and acknowledgment. This
 * bridge only turns its authenticated ACK into a stable runtime input. */
export class OriginCallbackBridge {
  constructor(private readonly dependencies: { runId: string; queue: ThreadInputQueue; notifications: RunNotificationAcknowledgmentPort }) {}

  request(input: { threadId: string; eventKey: string; title: string; body: string }): Promise<string> {
    return this.dependencies.notifications.enqueue({ runId: this.dependencies.runId, eventKey: input.eventKey, title: input.title, body: input.body });
  }

  async resumeAfterAcknowledgment(input: { notificationId: string; threadId: string; inputId: string }): Promise<boolean> {
    if (!await this.dependencies.notifications.isAcknowledged(input.notificationId)) return false;
    await this.dependencies.queue.enqueue({
      id: input.inputId,
      threadId: input.threadId,
      kind: "tool_event",
      payload: { originToolCallId: `notification:${input.notificationId}`, eventName: "origin_callback_acknowledged", result: { notificationId: input.notificationId } },
      createdAt: new Date().toISOString()
    });
    return true;
  }
}
