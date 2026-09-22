/**
 * AIR phase-1 spike: compact Agent Intermediate Representation header.
 *
 * The header is the machine-state summary a cheap decision engine (or a
 * router) reads instead of the full compiled brief. Field order is fixed so
 * headers are diffable across turns; every line is `KEY<pad>value`.
 *
 * Canonical shape:
 *
 *   GOAL      fix failing authentication tests
 *   STATE     repo.clean=true branch=feature/auth
 *   KNOWN     failure=token-expiration
 *   NEED      locate implementation
 *   PLAN      inspect -> diagnose -> patch -> test
 *   ACTIVE    inspect
 *   RESULTS   -
 *   BUDGET    tokens=medium time=120s
 *   POLICY    write=yes network=no
 */
export interface AirHeaderInput {
  goal: string;
  /** Folded facts, e.g. from foldStateDeltas(). Rendered as `k=v` pairs. */
  state?: Array<{ key: string; fact: string }>;
  known?: string[];
  need?: string;
  /** Ordered plan steps; rendered joined with ` -> `. */
  plan?: string[];
  active?: string;
  results?: string[];
  budget?: {
    tokens?: string;
    timeSeconds?: number;
    maxIterations?: number;
  };
  policy?: {
    write?: string;
    network?: string;
    commands?: string;
  };
}

const FIELD_WIDTH = 10;

function field(name: string, value: string): string {
  return `${name.padEnd(FIELD_WIDTH)}${value}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function compileAirHeader(input: AirHeaderInput, maxChars = 2000): string {
  const state = (input.state ?? [])
    .map((entry) => `${oneLine(entry.key)}=${oneLine(entry.fact)}`)
    .join(" ");
  const budgetParts: string[] = [];
  if (input.budget?.tokens) budgetParts.push(`tokens=${input.budget.tokens}`);
  if (typeof input.budget?.timeSeconds === "number") budgetParts.push(`time=${input.budget.timeSeconds}s`);
  if (typeof input.budget?.maxIterations === "number") budgetParts.push(`iters=${input.budget.maxIterations}`);
  const policyParts: string[] = [];
  if (input.policy?.write) policyParts.push(`write=${input.policy.write}`);
  if (input.policy?.network) policyParts.push(`network=${input.policy.network}`);
  if (input.policy?.commands) policyParts.push(`commands=${input.policy.commands}`);

  const lines = [
    field("GOAL", oneLine(input.goal) || "-"),
    field("STATE", state || "-"),
    field("KNOWN", (input.known ?? []).map(oneLine).filter(Boolean).join("; ") || "-"),
    field("NEED", oneLine(input.need ?? "") || "-"),
    field("PLAN", (input.plan ?? []).map(oneLine).filter(Boolean).join(" -> ") || "-"),
    field("ACTIVE", oneLine(input.active ?? "") || "-"),
    field("RESULTS", (input.results ?? []).map(oneLine).filter(Boolean).join("; ") || "-"),
    field("BUDGET", budgetParts.join(" ") || "-"),
    field("POLICY", policyParts.join(" ") || "-")
  ];
  const header = lines.join("\n");
  if (header.length <= maxChars) return header;
  return `${header.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n... (header truncated)`;
}
