/**
 * Unified promotion pipeline.
 *
 * Consolidates the three parallel promotion flows:
 * - agent-improvement promotions (eval-passing agent patches)
 * - tuning promotions (model routing / parameter tuning)
 * - learning promotions (learning proposal applications)
 *
 * All three follow: build queue → decide (approve/reject/defer) → apply.
 * This module provides the shared types, queue mechanics, and decision
 * logic; each domain supplies its item builder and applier.
 */

export type PromotionKind = "agent-improvement" | "tuning" | "learning";

export type PromotionStatus = "pending" | "approved" | "rejected" | "deferred" | "applied" | "superseded";

export type PromotionItem = {
  id: string;
  kind: PromotionKind;
  title: string;
  description: string;
  /** domain-specific payload (patch, config change, proposal) */
  payload: Record<string, unknown>;
  /** content hash for change detection */
  sourceHash: string;
  status: PromotionStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  appliedAt?: string;
};

export type PromotionQueue = {
  kind: PromotionKind;
  projectDir: string;
  items: PromotionItem[];
  updatedAt: string;
};

export type PromotionDecision = {
  ids: string[] | "all";
  status: "approved" | "rejected" | "deferred";
  reviewer?: string;
  note?: string;
};

export type PromotionDecisionResult = {
  decided: number;
  skipped: number;
  queue: PromotionQueue;
};

export function createPromotionQueue(kind: PromotionKind, projectDir: string, items: Omit<PromotionItem, "status" | "createdAt">[]): PromotionQueue {
  const now = new Date().toISOString();
  return {
    kind,
    projectDir,
    items: items.map((item) => ({
      ...item,
      status: "pending" as PromotionStatus,
      createdAt: now,
    })),
    updatedAt: now,
  };
}

export function decidePromotions(queue: PromotionQueue, decision: PromotionDecision): PromotionDecisionResult {
  const now = new Date().toISOString();
  const targetIds = decision.ids === "all"
    ? new Set(queue.items.filter((i) => i.status === "pending").map((i) => i.id))
    : new Set(decision.ids);
  let decided = 0;
  let skipped = 0;
  const items = queue.items.map((item) => {
    if (!targetIds.has(item.id)) return item;
    if (item.status !== "pending") {
      skipped += 1;
      return item;
    }
    decided += 1;
    return {
      ...item,
      status: decision.status,
      decidedAt: now,
      decidedBy: decision.reviewer,
      decisionNote: decision.note,
    };
  });
  return {
    decided,
    skipped,
    queue: { ...queue, items, updatedAt: now },
  };
}

export function approvedPromotions(queue: PromotionQueue): PromotionItem[] {
  return queue.items.filter((i) => i.status === "approved");
}

export function pendingPromotions(queue: PromotionQueue): PromotionItem[] {
  return queue.items.filter((i) => i.status === "pending");
}

export function markPromotionApplied(queue: PromotionQueue, id: string): PromotionQueue {
  const now = new Date().toISOString();
  return {
    ...queue,
    updatedAt: now,
    items: queue.items.map((item) =>
      item.id === id && item.status === "approved"
        ? { ...item, status: "applied" as PromotionStatus, appliedAt: now }
        : item
    ),
  };
}

/** Parse --ids style input: comma-separated ids or "all". */
export function parsePromotionIds(value: string | undefined): string[] | "all" {
  if (!value || value === "all") return "all";
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
