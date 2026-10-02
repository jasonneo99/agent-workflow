/**
 * Network egress visibility for model provider calls.
 *
 * Every outbound API call made by a provider is logged here: who called,
 * where it went, when, and how much data moved. Answers "what did it
 * send where" without capturing request/response bodies (which may
 * contain sensitive task content).
 */

export type EgressLogEntry = {
  timestamp: string;
  providerId: string;
  host: string;
  /** e.g. "POST /v1/chat/completions" — path only, no query params */
  endpoint: string;
  method: string;
  /** prompt + completion tokens when the provider reports usage */
  promptTokens?: number;
  completionTokens?: number;
  /** run/stage context when available */
  runId?: string;
  stageId?: string;
  workflowId?: string;
  durationMs: number;
  /** non-2xx outcomes */
  statusCode?: number;
  error?: string;
};

const egressLog: EgressLogEntry[] = [];
const MAX_ENTRIES = 1000;

export function logEgress(entry: Omit<EgressLogEntry, "timestamp">): EgressLogEntry {
  const full: EgressLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  egressLog.push(full);
  if (egressLog.length > MAX_ENTRIES) {
    egressLog.splice(0, egressLog.length - MAX_ENTRIES);
  }
  return full;
}

export function readEgressLog(limit = 100): EgressLogEntry[] {
  return egressLog.slice(-limit);
}

export function clearEgressLog(): void {
  egressLog.length = 0;
}

/** Summarize egress by provider + host for dashboards. */
export function summarizeEgress(): Array<{
  providerId: string;
  host: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  errors: number;
}> {
  const by = new Map<string, { providerId: string; host: string; calls: number; promptTokens: number; completionTokens: number; errors: number }>();
  for (const e of egressLog) {
    const key = `${e.providerId}\0${e.host}`;
    let agg = by.get(key);
    if (!agg) {
      agg = { providerId: e.providerId, host: e.host, calls: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
      by.set(key, agg);
    }
    agg.calls += 1;
    agg.promptTokens += e.promptTokens ?? 0;
    agg.completionTokens += e.completionTokens ?? 0;
    if (e.error || (e.statusCode !== undefined && e.statusCode >= 400)) agg.errors += 1;
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls);
}

/** Extract host + path from a URL for logging (drops query params and credentials). */
export function parseEgressUrl(url: string): { host: string; endpoint: string } {
  try {
    const u = new URL(url);
    return { host: u.host, endpoint: u.pathname || "/" };
  } catch {
    return { host: "unknown", endpoint: "/" };
  }
}
