/**
 * AIR phase-2 spike: the cheap decision-engine slot under model routing.
 *
 * Jason's hierarchy: deterministic -> rules, simple semantic decision -> Laya,
 * complex decision -> Luna/Terra, hard reasoning -> Sol. This module is the
 * "rules" rung and the plug-in slot where a Laya-class classifier will sit:
 * it decides routing from a compact AIR header instead of regexing an 8K
 * compiled brief.
 *
 * Contract: the engine NEVER sees the raw brief. It sees the parsed header
 * (structured fields). If the header carries too little signal, the engine
 * reports low confidence and routing.ts escalates to the legacy brief-parsing
 * path — the escalation rung, not a failure.
 */
import { compileAirHeader, parseAirHeader, type ParsedAirHeader } from "../../context-compiler/src/air.js";
import { foldStateDeltas } from "./state-deltas.js";
import type { ModelTier, StageExecutionInput } from "./types.js";

export interface RoutingEngineInput extends ParsedAirHeader {
  modelTier: ModelTier;
  workflowId: string;
  stageId: string;
  agentId: string;
}

export interface LocalHoldoutSignals {
  approved: boolean;
  provider: "local" | null;
  maxRisk: "low" | null;
  evidenceSuites: number | null;
  minEvidenceSuites: number | null;
  minQualityDelta: number | null;
  maxLatencyRegressionMs: number | null;
  promotableSuites: number | null;
  worstQualityDelta: number | null;
  worstLatencyDeltaMs: number | null;
}

export interface RoutingEngineDecision {
  promoteFastStages: boolean;
  feedbackSignals: string[];
  /** Learning-daemon style per-tier provider preference, e.g. { fast: "local" }. */
  preferredProviderByTier: Partial<Record<ModelTier, string>>;
  localHoldout: LocalHoldoutSignals;
  /** Advisory only in the spike; the router keeps its existing tier logic. */
  tierHint?: ModelTier;
  /** 0..1. Below 0.5 the router escalates to the legacy brief-parsing path. */
  confidence: number;
  reason: string;
}

export interface RoutingDecisionEngine {
  id: string;
  decide(input: RoutingEngineInput): RoutingEngineDecision;
}

/** Split "key: value" lines (already stripped of list markers) into pairs. */
function keyValuePairs(lines: string[]): Array<{ key: string; value: string }> {
  return lines
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx <= 0) return null;
      return { key: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1).trim() };
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null && entry.value.length > 0);
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const PROVIDER_ID_RE = /^[a-z0-9_-]+$/iu;

/**
 * Deterministic rules engine: the bottom rung of the escalation hierarchy.
 * Parses structured `key: value` KNOWN lines, never free prose.
 */
export class RuleBasedRoutingEngine implements RoutingDecisionEngine {
  readonly id = "rules-v1";

  decide(input: RoutingEngineInput): RoutingEngineDecision {
    const pairs = keyValuePairs(input.known);
    const get = (key: string): string | undefined => pairs.find((p) => p.key === key)?.value;

    const preferredProviderByTier: Partial<Record<ModelTier, string>> = {};
    for (const tier of ["fast", "standard", "reasoning"] as const) {
      const raw = get(`preferred provider ${tier}`);
      if (raw && PROVIDER_ID_RE.test(raw)) preferredProviderByTier[tier] = raw.toLowerCase();
    }

    const feedbackSignals = [
      ...input.known.filter((line) => /revised|rejected/i.test(line)),
      ...input.state.filter((entry) => /revised|rejected/i.test(`${entry.key} ${entry.fact}`)).map((entry) => `${entry.key}: ${entry.fact}`)
    ].slice(0, 3);
    const promoteFastStages = feedbackSignals.length > 0;

    const holdoutMarker = input.known.some((line) => line.trim().toLowerCase() === "local holdout promotion");
    const localHoldout: LocalHoldoutSignals = {
      approved:
        holdoutMarker &&
        get("status")?.toLowerCase() === "ready" &&
        get("approved")?.toLowerCase() === "yes",
      provider: get("provider")?.toLowerCase() === "local" ? "local" : null,
      maxRisk: get("max risk")?.toLowerCase() === "low" ? "low" : null,
      evidenceSuites: parseFiniteNumber(get("evidence suites")),
      minEvidenceSuites: parseFiniteNumber(get("min evidence suites")),
      minQualityDelta: parseFiniteNumber(get("min quality delta")),
      maxLatencyRegressionMs: parseFiniteNumber(get("max latency regression ms")),
      promotableSuites: parseFiniteNumber(get("promotable suites")),
      worstQualityDelta: parseFiniteNumber(get("worst quality delta")),
      worstLatencyDeltaMs: parseFiniteNumber(get("worst latency delta ms"))
    };

    let tierHint: ModelTier | undefined;
    if (input.budget.tokens === "low") tierHint = "fast";
    else if (typeof input.budget.timeSeconds === "number" && input.budget.timeSeconds <= 60) tierHint = "fast";

    // Confidence: how much structured signal did the header actually carry?
    const signals =
      (input.known.length > 0 ? 1 : 0) +
      (input.state.length > 0 ? 1 : 0) +
      (Object.keys(preferredProviderByTier).length > 0 ? 1 : 0) +
      (localHoldout.approved ? 1 : 0);
    const confidence = Math.min(1, 0.3 + signals * 0.2);

    const reasons: string[] = [];
    if (promoteFastStages) reasons.push(`feedback signals: ${feedbackSignals.join("; ")}`);
    if (localHoldout.approved) reasons.push("local holdout promotion approved");
    const preferred = Object.entries(preferredProviderByTier).map(([t, p]) => `${t}:${p}`).join(",");
    if (preferred) reasons.push(`preferred providers ${preferred}`);
    if (tierHint) reasons.push(`budget tier hint ${tierHint}`);

    return {
      promoteFastStages,
      feedbackSignals,
      preferredProviderByTier,
      localHoldout,
      tierHint,
      confidence,
      reason: reasons.length ? `rules-v1: ${reasons.join("; ")}` : "rules-v1: no routing signals in header"
    };
  }
}

export const defaultRoutingEngine: RoutingDecisionEngine = new RuleBasedRoutingEngine();

/**
 * Build the engine input from a stage execution input. The Adaptive Preference
 * Notes section of the compiled brief becomes structured KNOWN lines; the
 * runtime never hands the raw brief to the engine.
 */
export type RoutingEngineStageInput = Partial<
  Pick<
    StageExecutionInput,
    "modelTier" | "agentId" | "stageId" | "workflowId" | "workflowTask" | "stageGoal" | "compiledBrief" | "stagePattern" | "stateDeltas" | "projectConfig"
  >
>;

export function buildRoutingEngineInput(input: RoutingEngineStageInput): RoutingEngineInput {
  const brief = input.compiledBrief ?? "";
  const section = brief.split("## Adaptive Preference Notes")[1]?.split("\n## ")[0] ?? "";
  const known = section
    .split("\n")
    .map((line) => line.replace(/^- /u, "").trim())
    .filter(Boolean);
  const facts = input.stateDeltas?.length ? [...foldStateDeltas(input.stateDeltas).entries()] : [];
  const modelTier = input.modelTier ?? "standard";
  const budgetTokens = modelTier === "fast" ? "low" : modelTier === "reasoning" ? "high" : "medium";
  const actions = input.projectConfig?.actions;
  return {
    goal: input.stageGoal || input.workflowTask || "",
    state: facts.map(([key, record]) => ({ key, fact: record.fact })),
    known,
    need: "",
    plan: [],
    active: input.stageId ?? "",
    results: [],
    budget: { tokens: budgetTokens, maxIterations: input.stagePattern?.maxIterations },
    policy: {
      write: actions && actions.allowed_write_paths.length ? "yes" : "no",
      commands: actions && actions.allowed_commands.length ? "yes" : "no"
    },
    modelTier,
    workflowId: input.workflowId ?? "",
    stageId: input.stageId ?? "",
    agentId: input.agentId ?? ""
  };
}

/** Compile the canonical header text for a stage input (the logged/audited artifact). */
export function compileRoutingHeader(input: RoutingEngineStageInput): string {
  return compileAirHeader(buildRoutingEngineInput(input));
}

export function parseRoutingHeader(header: string): ParsedAirHeader {
  return parseAirHeader(header);
}
