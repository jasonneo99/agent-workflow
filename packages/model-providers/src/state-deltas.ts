/**
 * AIR phase-1 spike: typed state deltas.
 *
 * A state delta is the runtime's machine-readable record of "what changed"
 * during a stage: one fact asserted, updated, or retracted, with provenance.
 * Folding a delta log yields the current machine state, which the next model
 * turn can consume instead of re-reading an ever-growing transcript.
 *
 * Conventions:
 * - `key` is a stable fact identity, e.g. `file:src/auth/token.ts`.
 *   Two deltas with the same key refer to the same fact.
 * - `assert` adds the fact (or replaces it if the key already exists).
 * - `update` replaces the fact and records the previous text for the
 *   `~ old -> new` rendering. Updating a missing key behaves like assert.
 * - `retract` removes the fact. Retracting a missing key is a no-op.
 * - `confidence` is 0..1 and is clamped on fold; it is advisory only.
 */
export type StateDeltaOp = "assert" | "update" | "retract";

export interface StateDeltaProvenance {
  stageId: string;
  agentId: string;
  actionType: string;
  taskId?: string;
  artifactUri?: string;
}

export interface StateDelta {
  op: StateDeltaOp;
  /** Stable identity for the fact, e.g. `file:src/auth/token.ts`. */
  key: string;
  /** Human/model-readable statement of the fact. Empty for retract. */
  fact: string;
  provenance: StateDeltaProvenance;
  /** Advisory 0..1. Defaults to 1 when omitted. */
  confidence?: number;
  /** ISO-8601 timestamp of when the runtime recorded the delta. */
  assertedAt: string;
}

export interface FactRecord {
  fact: string;
  provenance: StateDeltaProvenance;
  confidence: number;
  assertedAt: string;
  updatedAt: string;
  previousFact?: string;
}

/** Fold a delta log into the current fact set. Later deltas win. */
export function foldStateDeltas(deltas: StateDelta[]): Map<string, FactRecord> {
  const facts = new Map<string, FactRecord>();
  for (const delta of deltas) {
    const key = delta.key.trim();
    if (!key) continue;
    const confidence = clampConfidence(delta.confidence);
    if (delta.op === "retract") {
      facts.delete(key);
      continue;
    }
    const existing = facts.get(key);
    const record: FactRecord = {
      fact: delta.fact,
      provenance: delta.provenance,
      confidence,
      assertedAt: existing?.assertedAt ?? delta.assertedAt,
      updatedAt: delta.assertedAt
    };
    if (existing && delta.op === "update") {
      record.previousFact = existing.fact;
    }
    facts.set(key, record);
  }
  return facts;
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Render folded facts as a compact machine-state block for prompts.
 * `+` asserted, `~` updated (old -> new), `-` retracted keys are omitted
 * because the fold already removed them; retractions only appear when
 * rendering a raw delta log via renderDeltaLog.
 */
export function renderFactSet(facts: Map<string, FactRecord>, maxChars = 4000): string {
  if (facts.size === 0) return "STATE (empty)";
  const lines: string[] = [];
  for (const [key, record] of facts) {
    const marker = record.previousFact ? "~" : "+";
    const confidence = record.confidence < 1 ? ` [conf ${record.confidence.toFixed(2)}]` : "";
    const line = record.previousFact
      ? `${marker} ${key}: ${record.previousFact} -> ${record.fact}${confidence}`
      : `${marker} ${key}: ${record.fact}${confidence}`;
    lines.push(line);
  }
  return truncateLines(lines, maxChars);
}

/** Render the raw delta log (including retractions) for debugging/audit. */
export function renderDeltaLog(deltas: StateDelta[], maxChars = 4000): string {
  if (deltas.length === 0) return "DELTAS (none)";
  const lines = deltas.map((delta) => {
    const marker = delta.op === "assert" ? "+" : delta.op === "update" ? "~" : "-";
    const at = delta.assertedAt ? ` @${delta.assertedAt}` : "";
    return `${marker} ${delta.key}: ${delta.fact}${at}`.trimEnd();
  });
  return truncateLines(lines, maxChars);
}

function truncateLines(lines: string[], maxChars: number): string {
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n... (+${lines.length} lines truncated)`;
}

/** Build a file-read delta from an executor file_read action result. */
export function fileReadDelta(input: {
  path: string;
  bytesRead?: number;
  truncated?: boolean;
  sha256?: string;
  error?: string;
  provenance: StateDeltaProvenance;
  assertedAt?: string;
}): StateDelta {
  const assertedAt = input.assertedAt ?? new Date().toISOString();
  if (input.error) {
    return {
      op: "assert",
      key: `file:${input.path}`,
      fact: `read denied: ${input.error}`,
      provenance: input.provenance,
      confidence: 1,
      assertedAt
    };
  }
  const sha = input.sha256 ? ` sha256:${input.sha256.slice(0, 12)}` : "";
  const truncated = input.truncated ? " (truncated at policy max)" : "";
  return {
    op: "assert",
    key: `file:${input.path}`,
    fact: `read ${input.bytesRead ?? 0} bytes${truncated}${sha}`,
    provenance: input.provenance,
    confidence: 1,
    assertedAt
  };
}

/** Build a command-execution delta from an executor local_command result. */
export function commandDelta(input: {
  command: string;
  exitCode?: number;
  outputPreview?: string;
  provenance: StateDeltaProvenance;
  assertedAt?: string;
}): StateDelta {
  const assertedAt = input.assertedAt ?? new Date().toISOString();
  const status = typeof input.exitCode === "number" ? (input.exitCode === 0 ? "ok" : `exit=${input.exitCode}`) : "ran";
  const preview = input.outputPreview ? `: ${input.outputPreview.slice(0, 160)}` : "";
  return {
    op: "assert",
    key: `cmd:${input.command.slice(0, 120)}`,
    fact: `${status}${preview}`,
    provenance: input.provenance,
    confidence: 1,
    assertedAt
  };
}
