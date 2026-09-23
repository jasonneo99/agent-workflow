export type AdaptiveRouteEvidence = {
  agentId: string;
  taskClass: string;
  providerId: string;
  modelId?: string;
  samples: number;
  quality: number;
  taskSuccess: number;
  fallbackRate: number;
  latencyMs?: number;
  costUsd?: number;
  observedAt: string;
};

export type AdaptiveEvidenceDecision = {
  status: "selected" | "insufficient-evidence" | "poor-performance";
  candidate?: AdaptiveRouteEvidence;
  confidence: number;
  reason: string;
};

const maxEvidenceAgeMs = 30 * 24 * 60 * 60 * 1000;

export function selectAdaptiveEvidence(
  evidence: AdaptiveRouteEvidence[],
  input: { agentId: string; taskClass: string; now?: Date }
): AdaptiveEvidenceDecision {
  const now = input.now ?? new Date();
  const matching = evidence.filter((item) => item.agentId === input.agentId && item.taskClass === input.taskClass);
  const fresh = matching
    .map((item) => ({ item, ageMs: now.getTime() - Date.parse(item.observedAt) }))
    .filter(({ ageMs }) => Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxEvidenceAgeMs);
  const sufficientlySampled = fresh.filter(({ item }) => item.samples >= 3);
  if (!sufficientlySampled.length) {
    return { status: "insufficient-evidence", confidence: 0, reason: "No fresh candidate has the minimum three samples for this agent and task class." };
  }
  const passing = sufficientlySampled.filter(({ item }) => item.quality >= 0.7 && item.taskSuccess >= 0.8 && item.fallbackRate <= 0.1);
  if (!passing.length) {
    return { status: "poor-performance", confidence: 0, reason: "Fresh candidates exist, but none pass the quality, task-success, and fallback gates." };
  }
  const ranked = passing.map(({ item, ageMs }) => {
    const freshness = Math.max(0, 1 - ageMs / maxEvidenceAgeMs);
    const sampleConfidence = Math.min(1, item.samples / 10);
    const latencyScore = item.latencyMs === undefined ? 0.5 : 1 / (1 + item.latencyMs / 30_000);
    const costScore = item.costUsd === undefined ? 0.5 : 1 / (1 + item.costUsd * 10);
    const score = item.quality * 0.35 + item.taskSuccess * 0.3 + (1 - item.fallbackRate) * 0.15 + latencyScore * 0.08 + costScore * 0.04 + freshness * 0.08;
    return { item, score, confidence: Number((sampleConfidence * freshness).toFixed(3)) };
  }).sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.item.providerId.localeCompare(b.item.providerId));
  const selected = ranked[0]!;
  return {
    status: "selected",
    candidate: selected.item,
    confidence: selected.confidence,
    reason: `Selected ${selected.item.providerId}${selected.item.modelId ? `/${selected.item.modelId}` : ""} from fresh per-agent task evidence (confidence ${selected.confidence}).`
  };
}

export function parseAdaptiveRouteEvidence(compiledBrief: string): AdaptiveRouteEvidence[] {
  const section = compiledBrief.split("## Adaptive Route Evidence")[1]?.split("\n## ")[0] ?? "";
  const records: AdaptiveRouteEvidence[] = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^- \{(.+)\}$/u);
    if (!match) continue;
    try {
      const value = JSON.parse(`{${match[1]}}`) as Partial<AdaptiveRouteEvidence>;
      if (typeof value.agentId === "string" && typeof value.taskClass === "string" && typeof value.providerId === "string" && typeof value.samples === "number" && typeof value.quality === "number" && typeof value.taskSuccess === "number" && typeof value.fallbackRate === "number" && typeof value.observedAt === "string") {
        records.push(value as AdaptiveRouteEvidence);
      }
    } catch {
      // Malformed daemon evidence is ignored and cannot influence routing.
    }
  }
  return records;
}
