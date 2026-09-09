export type LocalRoutingRouteClass = "local-selected" | "local-skipped" | "hosted-fallback" | "hosted-selected";

export type LocalRoutingRecommendationAction = "expand" | "hold" | "retreat";

export type LocalRoutingRecommendationPriority = "low" | "medium" | "high";

export type LocalRoutingFeedbackRating = "helpful" | "costly" | "neutral";

export type LocalRoutingRouteGroup = {
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  classification: LocalRoutingRouteClass;
  runs: number;
  fallbackCount: number;
  averageLatencyMs: number | null;
  averageQuality: number | null;
};

export type LocalRoutingFeedbackEvent = {
  rating: LocalRoutingFeedbackRating;
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  routeClass: LocalRoutingRouteClass;
};

export type LocalRoutingFeedbackSummary = Record<LocalRoutingFeedbackRating | "total", number>;

export type LocalRoutingRecommendation = {
  id: string;
  action: LocalRoutingRecommendationAction;
  priority: LocalRoutingRecommendationPriority;
  workflowId: string;
  stageId: string;
  agentId: string;
  providerId: string;
  modelTier: string;
  routeClass: LocalRoutingRouteClass;
  runs: number;
  fallbackRate: number;
  averageQuality: number | null;
  averageLatencyMs: number | null;
  estimatedNetSavingsUsd: number;
  routeFeedback: LocalRoutingFeedbackSummary;
  recommendation: string;
  reasons: string[];
};

export type LocalRoutingRecommendationInput = {
  routeGroups: LocalRoutingRouteGroup[];
  netEstimatedSavingsUsd: number;
  storagePressure: boolean;
  routeFeedbackEvents?: LocalRoutingFeedbackEvent[];
};

export function buildSavingsAwareLocalRoutingRecommendations(
  input: LocalRoutingRecommendationInput
): LocalRoutingRecommendation[] {
  const recommendations: LocalRoutingRecommendation[] = [];
  const groups = input.routeGroups
    .slice()
    .sort((a, b) => b.runs - a.runs || a.workflowId.localeCompare(b.workflowId))
    .slice(0, 20);
  for (const group of groups) {
    const recommendation = recommendLocalRoutingForGroup(group, {
      netEstimatedSavingsUsd: input.netEstimatedSavingsUsd,
      storagePressure: input.storagePressure,
      routeFeedbackEvents: input.routeFeedbackEvents ?? []
    });
    recommendations.push({
      ...recommendation,
      id: `route-${String(recommendations.length + 1).padStart(3, "0")}`
    });
  }
  if (!recommendations.length) {
    recommendations.push({
      id: "route-001",
      action: "hold",
      priority: "low",
      workflowId: "all",
      stageId: "all",
      agentId: "all",
      providerId: "local",
      modelTier: "fast",
      routeClass: "local-skipped",
      runs: 0,
      fallbackRate: 0,
      averageQuality: null,
      averageLatencyMs: null,
      estimatedNetSavingsUsd: input.netEstimatedSavingsUsd,
      routeFeedback: emptyLocalRoutingFeedbackSummary(),
      recommendation: "Collect route receipts before changing local routing.",
      reasons: ["No route receipt groups were available in the inspected run window."]
    });
  }
  return recommendations;
}

function recommendLocalRoutingForGroup(
  group: LocalRoutingRouteGroup,
  context: {
    netEstimatedSavingsUsd: number;
    storagePressure: boolean;
    routeFeedbackEvents: LocalRoutingFeedbackEvent[];
  }
): Omit<LocalRoutingRecommendation, "id"> {
  const quality = group.averageQuality ?? null;
  const fallbackRate = group.runs > 0 ? group.fallbackCount / group.runs : 0;
  const netSavingsPositive = context.netEstimatedSavingsUsd > 0;
  const feedback = summarizeLocalRoutingFeedbackForGroup(context.routeFeedbackEvents, group);
  let action: LocalRoutingRecommendationAction = "hold";
  let priority: LocalRoutingRecommendationPriority = "low";
  const reasons: string[] = [
    `${group.runs} recent route receipt(s) for ${group.providerId}/${group.modelTier}.`,
    group.averageLatencyMs === null ? "No latency samples yet." : `Average latency is ${group.averageLatencyMs}ms.`,
    quality === null ? "No quality score yet." : `Average quality is ${quality}.`,
    feedback.total
      ? `Operator route feedback is helpful=${feedback.helpful}, costly=${feedback.costly}, neutral=${feedback.neutral}.`
      : "No route-level operator feedback yet."
  ];
  if (feedback.costly >= 2 && feedback.costly > feedback.helpful && group.classification === "local-selected") {
    action = "retreat";
    priority = "high";
    reasons.push("Repeated operator feedback marked this local route as costly.");
  } else if (feedback.costly >= 2 && feedback.costly > feedback.helpful && (group.classification === "hosted-selected" || group.classification === "local-skipped")) {
    action = "hold";
    priority = "medium";
    reasons.push("Repeated costly feedback blocks local expansion for this route group.");
  } else if (group.classification === "local-selected" && (fallbackRate >= 0.25 || (quality !== null && quality < 0.65) || context.storagePressure && !netSavingsPositive)) {
    action = "retreat";
    priority = "high";
    if (fallbackRate >= 0.25) reasons.push(`Fallback rate ${fallbackRate.toFixed(2)} is too high for broader local routing.`);
    if (quality !== null && quality < 0.65) reasons.push("Quality is below the local expansion threshold.");
    if (context.storagePressure && !netSavingsPositive) reasons.push("Storage pressure plus non-positive savings makes this a poor local candidate.");
  } else if (
    (group.classification === "hosted-selected" || group.classification === "local-skipped") &&
    group.modelTier === "fast" &&
    netSavingsPositive &&
    !context.storagePressure &&
    (quality === null || quality >= 0.75 || feedback.helpful >= 2) &&
    fallbackRate <= 0.1
  ) {
    action = "expand";
    priority = feedback.helpful >= 2 || group.runs >= 3 ? "medium" : "low";
    reasons.push("Fast-tier hosted work looks eligible for local trial because savings are positive and quality evidence is acceptable.");
    if (feedback.helpful >= 2) reasons.push("Repeated helpful feedback strengthens this local trial candidate.");
  } else if (group.classification === "local-selected" && netSavingsPositive && fallbackRate <= 0.1 && (quality === null || quality >= 0.75 || feedback.helpful >= 2)) {
    action = "hold";
    priority = "medium";
    reasons.push("Current local routing appears healthy; keep collecting benchmark and feedback evidence before expanding.");
    if (feedback.helpful >= 2) reasons.push("Repeated helpful feedback supports keeping this local route active.");
  } else {
    reasons.push("Evidence is not strong enough to change routing boundaries yet.");
  }
  return {
    action,
    priority,
    workflowId: group.workflowId,
    stageId: group.stageId,
    agentId: group.agentId,
    providerId: group.providerId,
    modelTier: group.modelTier,
    routeClass: group.classification,
    runs: group.runs,
    fallbackRate: Number(fallbackRate.toFixed(2)),
    averageQuality: group.averageQuality,
    averageLatencyMs: group.averageLatencyMs,
    estimatedNetSavingsUsd: context.netEstimatedSavingsUsd,
    routeFeedback: feedback,
    recommendation: localRoutingRecommendationText(action, group),
    reasons
  };
}

export function summarizeLocalRoutingFeedbackForGroup(
  events: LocalRoutingFeedbackEvent[],
  group: LocalRoutingRouteGroup
): LocalRoutingFeedbackSummary {
  const summary = emptyLocalRoutingFeedbackSummary();
  for (const event of events) {
    if (
      event.workflowId === group.workflowId &&
      event.stageId === group.stageId &&
      event.agentId === group.agentId &&
      event.providerId === group.providerId &&
      event.modelTier === group.modelTier &&
      event.routeClass === group.classification
    ) {
      summary[event.rating] += 1;
      summary.total += 1;
    }
  }
  return summary;
}

function emptyLocalRoutingFeedbackSummary(): LocalRoutingFeedbackSummary {
  return {
    helpful: 0,
    costly: 0,
    neutral: 0,
    total: 0
  };
}

function localRoutingRecommendationText(action: LocalRoutingRecommendationAction, group: LocalRoutingRouteGroup): string {
  if (action === "expand") {
    return `Trial local routing for ${group.workflowId}/${group.stageId} before broader promotion.`;
  }
  if (action === "retreat") {
    return `Move ${group.workflowId}/${group.stageId} back toward hosted fallback until quality, fallback, or storage evidence improves.`;
  }
  return `Keep current routing for ${group.workflowId}/${group.stageId}.`;
}
