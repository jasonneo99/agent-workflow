export interface DeliveryMetricReceipt {
  id: string; runId: string; actionType: string; target: string; createdAt: string;
  metadata: Record<string, unknown>;
}
export interface DeliveryMetricRun { id: string; startedAt: string; status: string }
export interface DeliveryAudit { runId: string; uri: string; createdAt: string; accepted: boolean }

/** Receipt observations are distinct from causal conclusions about wasted work. */
export function deliveryMetrics(runs: DeliveryMetricRun[], receipts: DeliveryMetricReceipt[], audits: DeliveryAudit[]) {
  const ordered = [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const knownRuns = new Set(runs.map((run) => run.id));
  const accepted = audits.filter((audit) => {
    const run = runs.find((candidate) => candidate.id === audit.runId);
    const observedAt = Date.parse(audit.createdAt);
    const startedAt = run ? Date.parse(run.startedAt) : NaN;
    return audit.accepted === true && knownRuns.has(audit.runId) && audit.uri.startsWith("db://")
      && Number.isFinite(observedAt) && Number.isFinite(startedAt) && observedAt >= startedAt;
  })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  const observations = receipts.filter((receipt) => {
    const run = runs.find((candidate) => candidate.id === receipt.runId);
    const observedAt = Date.parse(receipt.createdAt);
    const startedAt = run ? Date.parse(run.startedAt) : NaN;
    return Number.isFinite(observedAt) && Number.isFinite(startedAt) && observedAt >= startedAt;
  })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const auditedObservations = (classification: string) => {
    const evidence = observations.filter((receipt) => receipt.actionType === "delivery_metric_audit"
      && receipt.metadata.audited === true && receipt.metadata.classification === classification
      && typeof receipt.metadata.evidenceUri === "string" && receipt.metadata.evidenceUri.startsWith("db://"));
    return { coverage: evidence.length ? "partial" : "unknown", count: evidence.length || null,
      receiptIds: evidence.map((receipt) => receipt.id),
      evidenceUris: evidence.map((receipt) => String(receipt.metadata.evidenceUri)) };
  };
  const repeated = (kind: string) => {
    const seen = new Set<string>();
    return observations.filter((receipt) => {
      if (receipt.actionType !== kind) return false;
      const key = receipt.target;
      const duplicate = seen.has(key); seen.add(key); return duplicate;
    }).map((receipt) => receipt.id);
  };
  const repeatedReads = repeated("file_read"), repeatedSearches = repeated("file_search");
  const modelSamples = new Map<string, { latencyMs: number; receiptId: string }>();
  for (const receipt of observations) {
    if (!["model_route", "model_route_failed"].includes(receipt.actionType) || !Array.isArray(receipt.metadata.attempts)) continue;
    for (const attempt of receipt.metadata.attempts) {
      if (typeof attempt?.attemptId === "string" && typeof attempt.latencyMs === "number" && Number.isFinite(attempt.latencyMs) && attempt.latencyMs >= 0) {
        modelSamples.set(JSON.stringify([receipt.runId, attempt.attemptId]), { latencyMs: attempt.latencyMs, receiptId: receipt.id });
      }
    }
  }
  const duration = accepted && ordered[0] ? Date.parse(accepted.createdAt) - Date.parse(ordered[0].startedAt) : NaN;
  return {
    version: 1,
    runIds: ordered.map((run) => run.id),
    verifiedDelivery: Boolean(accepted), acceptanceEvidence: accepted?.uri ?? null,
    firstAttemptVerifiedSuccess: accepted ? accepted.runId === ordered[0]?.id : null,
    timeToVerifiedDeliveryMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
    observedRunCount: ordered.length,
    observedUnnecessaryRetries: auditedObservations("unnecessary_retry"),
    observedFalseBlocks: auditedObservations("false_block"),
    observedApprovals: auditedObservations("approval"),
    observedHumanInterventions: auditedObservations("human_intervention"),
    repeatedReadRequests: { coverage: observations.some((receipt) => receipt.actionType === "file_read") ? "partial" : "unknown", count: observations.some((receipt) => receipt.actionType === "file_read") ? repeatedReads.length : null, receiptIds: repeatedReads },
    repeatedDiscoveryRequests: { coverage: observations.some((receipt) => receipt.actionType === "file_search") ? "partial" : "unknown", count: observations.some((receipt) => receipt.actionType === "file_search") ? repeatedSearches.length : null, receiptIds: repeatedSearches },
    observedModelCalls: { coverage: modelSamples.size ? "partial" : "unknown", count: modelSamples.size || null,
      totalLatencyMs: modelSamples.size ? [...modelSamples.values()].reduce((total, sample) => total + sample.latencyMs, 0) : null,
      receiptIds: [...new Set([...modelSamples.values()].map((sample) => sample.receiptId))] },
    // No causal claim can be inferred just from a retry, block or completion flag.
    unnecessaryRetries: null, falseBlocks: null, humanInterventions: null, approvals: null, modelLatencyMs: null,
    unknownReasons: {
      unnecessaryRetries: "Requires an audited retry-necessity classification.",
      falseBlocks: "Requires a confirmed false-block finding, not merely a later success.",
      humanInterventions: "Requester and operator intervention events are not comprehensively instrumented.",
      approvals: "Action approval table must be joined before reporting approval totals.",
      modelLatencyMs: "Stage route latency includes orchestration and is not isolated model latency."
    }
  };
}
