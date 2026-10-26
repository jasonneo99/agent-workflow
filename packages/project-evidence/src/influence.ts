import { createHash } from "node:crypto";
export const influenceHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export interface ContextInfluenceReference {
  kind: "file" | "indexed_summary" | "excerpt" | "tuning" | "preference" | "agent" | "workflow" | "prior_run" | "prior_receipt" | "stage_artifact" | "state_delta" | "memory_context";
  key: string; includedHash: string; sourceHash?: string; observedAt: string | null;
  freshness: "read_at_compile" | "unverified" | "historical"; confidence: "recorded" | "indexed";
  target?: { type: "file" | "run"; value: string }; truncated?: boolean;
}
export interface ContextInfluence {
  schemaVersion: 1; authority: "none"; meaning: "context-supplied-not-proof-of-causal-reasoning";
  contextHash: string; capturedAt: string; references: ContextInfluenceReference[];
  graphRelationships: []; graphStatus: "not_supplied";
}
export function contextInfluence(text: string, references: ContextInfluenceReference[]): ContextInfluence {
  return { schemaVersion: 1, authority: "none", meaning: "context-supplied-not-proof-of-causal-reasoning", contextHash: influenceHash(text), capturedAt: new Date().toISOString(), references, graphRelationships: [], graphStatus: "not_supplied" };
}
