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

/** Structured form of a compiled AIR header. parseAirHeader is the inverse of compileAirHeader. */
export interface ParsedAirHeader {
  goal: string;
  state: Array<{ key: string; fact: string }>;
  known: string[];
  need: string;
  plan: string[];
  active: string;
  results: string[];
  budget: {
    tokens?: string;
    timeSeconds?: number;
    maxIterations?: number;
  };
  policy: {
    write?: string;
    network?: string;
    commands?: string;
  };
}

function dashToEmpty(value: string): string {
  return value === "-" ? "" : value;
}

/** Parse STATE `k=v` pairs; values may contain spaces, so tokens without `=` continue the previous value. */
function parseStatePairs(value: string): Array<{ key: string; fact: string }> {
  const pairs: Array<{ key: string; fact: string }> = [];
  let current: { key: string; fact: string } | null = null;
  for (const token of value.split(" ")) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      current = { key: token.slice(0, eq), fact: token.slice(eq + 1) };
      pairs.push(current);
    } else if (current && token) {
      current.fact += ` ${token}`;
    }
  }
  return pairs.filter((pair) => pair.key && pair.fact);
}

function parseKeyValues(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of value.split(" ")) {
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function parseSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value.replace(/s$/u, ""));
  return Number.isFinite(n) ? n : undefined;
}

function parseInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const splitList = (value: string, sep: string): string[] =>
  dashToEmpty(value) ? dashToEmpty(value).split(sep).map((item) => item.trim()).filter(Boolean) : [];

/** Parse a compiled AIR header back into structured fields. Never throws on malformed input. */
export function parseAirHeader(header: string): ParsedAirHeader {
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const name = line.slice(0, FIELD_WIDTH).trim().toUpperCase();
    if (!name) continue;
    fields.set(name, line.slice(FIELD_WIDTH).trim());
  }
  const get = (name: string): string => fields.get(name) ?? "";
  const budget = parseKeyValues(dashToEmpty(get("BUDGET")));
  const policy = parseKeyValues(dashToEmpty(get("POLICY")));
  return {
    goal: dashToEmpty(get("GOAL")),
    state: parseStatePairs(dashToEmpty(get("STATE"))),
    known: splitList(get("KNOWN"), ";"),
    need: dashToEmpty(get("NEED")),
    plan: splitList(get("PLAN"), " -> "),
    active: dashToEmpty(get("ACTIVE")),
    results: splitList(get("RESULTS"), ";"),
    budget: {
      tokens: budget.tokens,
      timeSeconds: parseSeconds(budget.time),
      maxIterations: parseInt(budget.iters)
    },
    policy: {
      write: policy.write,
      network: policy.network,
      commands: policy.commands
    }
  };
}
