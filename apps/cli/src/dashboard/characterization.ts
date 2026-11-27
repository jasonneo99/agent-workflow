/** Pure helpers for the dashboard characterization harness
 * (scripts/dashboard-characterization.ts): which routes to request, and how to
 * normalize a response so that two runs against freshly seeded throwaway data
 * compare equal unless behavior changed. */

import { createHash } from "node:crypto";

export interface CharacterizationRoute {
  path: string;
  /** Query parameters the handler reads, used to request seeded variants. */
  params: string[];
}

export interface CharacterizationSample {
  key: string;
  /** Set by calibration: the body differs between two runs of the same code,
   * so only status and content type are compared. */
  volatile?: boolean;
  status: number;
  contentType: string;
  hash: string;
  bytes: number;
}

// A handler that reads a form body, spawns, prunes, restores or deletes is an
// action, even when it lacks a method check; the harness never requests it.
const ACTION_MARKERS = /readFormBody|readJsonBody|spawn\(|execFile|await\s+(?:\w+\.)?(?:prune|restore|delete|remove|cancel|approve|reject|retry|enqueue|withdraw|apply|execute|record|write|update|create|insert)\w*\(/u;

/** GET-able literal routes from a dashboard source file, in source order. */
export function extractDashboardRoutes(source: string): CharacterizationRoute[] {
  const routes = new Map<string, Set<string>>();
  const condition = /if\s*\(([^\n{]*requestUrl\.pathname\s*===\s*"[^"]+"[^\n{]*)\)\s*\{/gu;
  for (const match of source.matchAll(condition)) {
    const text = match[1] ?? "";
    if (/request\.method\s*===\s*"(POST|PUT|PATCH|DELETE)"/u.test(text)) continue;
    const block = handlerBody(source, (match.index ?? 0) + match[0].length);
    if (ACTION_MARKERS.test(block)) continue;
    const params = new Set([...block.matchAll(/searchParams\.get\("([a-zA-Z]+)"\)/gu)].map(item => item[1]!));
    for (const literal of text.matchAll(/requestUrl\.pathname\s*===\s*"([^"]+)"/gu)) {
      const path = literal[1]!;
      if (!path.startsWith("/")) continue;
      const known = routes.get(path) ?? new Set<string>();
      for (const param of params) known.add(param);
      routes.set(path, known);
    }
  }
  return [...routes].map(([path, params]) => ({ path, params: [...params].sort() }));
}

/** The handler body after its opening brace, by brace depth (capped). */
function handlerBody(source: string, start: number): string {
  let depth = 1;
  for (let index = start; index < source.length && index < start + 6000; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, index);
  }
  return source.slice(start, start + 6000);
}

export interface NormalizeContext {
  /** Literal strings (seeded ids, temp paths) mapped to stable labels. */
  labels: Array<[string, string]>;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?\b/gu;
const LONG_HEX = /\b[0-9a-f]{16,}\b/giu;
// Short ids (abbreviated uuids, hashes) mix letters and digits.
const SHORT_HEX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,15}\b/giu;
const REQUEST_ID = /\breq_[0-9a-z]{6,}\b/giu;
const DIGITS = /\d+(\.\d+)?/gu;

/** Replace run-to-run noise with placeholders. Seeded ids and paths become
 * labels first, so a page that shows the wrong seeded run still differs. */
export function normalizeResponse(body: string, context: NormalizeContext): string {
  let text = body;
  for (const [literal, label] of [...context.labels].sort((a, b) => b[0].length - a[0].length)) {
    if (literal) text = text.split(literal).join(label);
    const short = literal.match(/^[0-9a-f]{8}(?=-)/u)?.[0];
    if (short) text = text.split(short).join(`${label}:short`);
  }
  return text
    .replace(UUID, "<uuid>")
    .replace(ISO, "<time>")
    .replace(LONG_HEX, "<hex>")
    .replace(SHORT_HEX, "<hex>")
    .replace(REQUEST_ID, "req_<id>")
    .replace(/\b(nonce|integrity)="[^"]*"/gu, '$1="<token>"')
    .replace(DIGITS, "#")
    .replace(/#\s?(ms|s|m|h|d|sec|min|seconds|minutes|hours|days)\b/gu, "#<duration>")
    // An abbreviated id can be all digits in one run and hex in the next.
    .replace(/<hex>/gu, "#")
    .replace(/[ \t]+/gu, " ");
}

export function sampleKey(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}

/** Order-insensitive hash: rows that share a timestamp come back in any order,
 * so the hash covers the sorted multiset of markup-delimited fragments. */
export function hashNormalized(text: string): string {
  const fragments = text.split(/[<>{}\n]+/u).map(item => item.trim()).filter(Boolean).sort();
  return createHash("sha256").update(fragments.join("\n")).digest("hex").slice(0, 16);
}

/** Keys whose status, type or normalized body changed between two recordings. */
export function compareSamples(baseline: CharacterizationSample[], current: CharacterizationSample[]): Array<{ key: string; change: string }> {
  const now = new Map(current.map(sample => [sample.key, sample]));
  const changes: Array<{ key: string; change: string }> = [];
  for (const before of baseline) {
    const after = now.get(before.key);
    if (!after) { changes.push({ key: before.key, change: "missing" }); continue; }
    if (after.status !== before.status) changes.push({ key: before.key, change: `status ${before.status} -> ${after.status}` });
    else if (after.contentType !== before.contentType) changes.push({ key: before.key, change: `type ${before.contentType} -> ${after.contentType}` });
    else if (!before.volatile && after.hash !== before.hash) changes.push({ key: before.key, change: `body changed (${before.bytes} -> ${after.bytes} bytes)` });
  }
  return changes;
}
