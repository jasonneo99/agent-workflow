import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveContainedProjectPath } from "../../roadmap-planner/src/index.js";

export const ROADMAP_MAX_BYTES = 1_000_000;
export const ROADMAP_MAX_ITEMS = 500;
export const ROADMAP_STALE_AFTER_SECONDS = 86_400;

export type RoadmapSnapshotItem = { id: string; title: string; section: string | null; line: number; status: "open" | "done" };
export type RoadmapSnapshotSection = { section: string | null; totalItems: number; openItems: number; doneItems: number };
export type RoadmapSnapshot = {
  version: 1; projectId: string; projectName: string; source: string; digest: string;
  sourceModifiedAt: string | null; publishedAt: string; publishingHost: string;
  status: "ready" | "empty" | "missing" | "unavailable"; reason: string | null;
  totalItems: number; openItems: number; truncated: boolean; items: RoadmapSnapshotItem[];
  capturedItems: number; returnedItems: number; itemOffset: number; itemLimit: number; hasMore: boolean; nextOffset: number | null;
  sections: RoadmapSnapshotSection[];
};
export type ServerRoadmapSnapshot = RoadmapSnapshot & { freshness: "current" | "stale" | "missing" | "invalid"; ageSeconds: number | null };

function boundedText(value: string, limit: number): string { return value.trim().slice(0, limit); }
function redactHostPaths(value: string): string {
  return value.replace(/\/(?:Users|home)\/[^\s`'"<>]+/gu, "[local-path]").replace(/[A-Za-z]:\\[^\s`'"<>]+/gu, "[local-path]");
}
function validRelativeSource(source: string): boolean {
  if (!source || path.isAbsolute(source) || source.includes("\\")) return false;
  const normalized = path.posix.normalize(source);
  return normalized !== ".." && !normalized.startsWith("../") && normalized === source;
}

function roadmapItems(markdown: string, source: string): RoadmapSnapshotItem[] {
  const lines = markdown.split(/\r?\n/u);
  const items: RoadmapSnapshotItem[] = [];
  let section: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (heading) section = boundedText(redactHostPaths(heading[1]), 160);
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/u);
    if (!task) continue;
    const titleParts = [task[2]];
    let continuationIndex = index + 1;
    while (continuationIndex < lines.length) {
      const continuation = lines[continuationIndex];
      if (!/^\s{2,}\S/u.test(continuation) || /^\s*(?:[-*+]\s|#{1,6}\s|```|~~~)/u.test(continuation)) break;
      titleParts.push(continuation.trim());
      continuationIndex += 1;
    }
    const title = boundedText(redactHostPaths(titleParts.join(" ")), 240);
    if (!title) continue;
    items.push({
      id: `roadmap-${createHash("sha256").update(`${source}:${index + 1}:${title}`).digest("hex").slice(0, 16)}`,
      title, section, line: index + 1, status: task[1].toLowerCase() === "x" ? "done" : "open"
    });
  }
  return items;
}

function sectionAggregates(items: RoadmapSnapshotItem[]): RoadmapSnapshotSection[] {
  const sections = new Map<string | null, RoadmapSnapshotSection>();
  for (const item of items) {
    const aggregate = sections.get(item.section) ?? { section: item.section, totalItems: 0, openItems: 0, doneItems: 0 };
    aggregate.totalItems += 1;
    aggregate[item.status === "open" ? "openItems" : "doneItems"] += 1;
    sections.set(item.section, aggregate);
  }
  return [...sections.values()];
}

export function buildRoadmapSnapshot(input: {
  projectId: string; projectName: string; source: string; publishingHost: string; markdown?: string;
  sourceModifiedAt?: string; publishedAt?: string; status?: "missing" | "unavailable"; reason?: string; limit?: number;
}): RoadmapSnapshot {
  if (!validRelativeSource(input.source)) throw new Error("roadmap source must be a normalized project-relative path");
  const publishedAt = input.publishedAt ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(input.limit ?? ROADMAP_MAX_ITEMS, ROADMAP_MAX_ITEMS));
  const allItems = input.markdown === undefined ? [] : roadmapItems(input.markdown, input.source);
  const items = allItems.slice(0, limit);
  const status = input.status ?? (allItems.length ? "ready" : "empty");
  return {
    version: 1, projectId: boundedText(input.projectId, 160), projectName: boundedText(input.projectName, 160), source: input.source,
    digest: createHash("sha256").update(input.markdown ?? "").digest("hex"), sourceModifiedAt: input.sourceModifiedAt ?? null,
    publishedAt, publishingHost: boundedText(input.publishingHost, 255), status,
    reason: input.reason ? boundedText(input.reason, 240) : null, totalItems: allItems.length,
    openItems: allItems.filter((item) => item.status === "open").length, truncated: allItems.length > limit, items,
    capturedItems: items.length, returnedItems: items.length, itemOffset: 0, itemLimit: limit, hasMore: false, nextOffset: null,
    sections: sectionAggregates(allItems)
  };
}

export function paginateRoadmapSnapshot(snapshot: RoadmapSnapshot, offset = 0, limit = 100): RoadmapSnapshot {
  const itemOffset = Math.max(0, Math.min(Math.trunc(offset), snapshot.items.length));
  const itemLimit = Math.max(1, Math.min(Math.trunc(limit), ROADMAP_MAX_ITEMS));
  const items = snapshot.items.slice(itemOffset, itemOffset + itemLimit);
  const availableItems = snapshot.items.length;
  return {
    ...snapshot,
    items,
    capturedItems: snapshot.capturedItems,
    returnedItems: items.length,
    itemOffset,
    itemLimit,
    hasMore: itemOffset + items.length < availableItems,
    nextOffset: itemOffset + items.length < availableItems ? itemOffset + items.length : null,
    truncated: availableItems < snapshot.totalItems || itemOffset > 0 || itemOffset + items.length < availableItems
  };
}

export async function readRoadmapSnapshotFromProject(input: {
  projectId: string; projectName: string; projectRootUri: string; source: string; publishingHost: string; limit?: number; maxBytes?: number;
}): Promise<RoadmapSnapshot> {
  const base = { projectId: input.projectId, projectName: input.projectName, source: input.source, publishingHost: input.publishingHost, limit: input.limit };
  const absolutePath = await resolveContainedProjectPath({ projectRootUri: input.projectRootUri, relativePath: input.source, label: "project.roadmap_path" });
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) return buildRoadmapSnapshot({ ...base, status: "unavailable", reason: "source is not a regular file" });
    if (stats.size > (input.maxBytes ?? ROADMAP_MAX_BYTES)) return buildRoadmapSnapshot({ ...base, status: "unavailable", reason: "source exceeds size limit" });
    return buildRoadmapSnapshot({ ...base, markdown: await fs.readFile(absolutePath, "utf8"), sourceModifiedAt: stats.mtime.toISOString() });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return buildRoadmapSnapshot({ ...base, status: missing ? "missing" : "unavailable", reason: missing ? "configured roadmap does not exist" : "configured roadmap could not be safely read" });
  }
}

export function parseRoadmapSnapshot(value: unknown, expectedProjectId: string): RoadmapSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Partial<RoadmapSnapshot>;
  if (c.version !== 1 || c.projectId !== expectedProjectId || typeof c.projectName !== "string" || c.projectName.length > 160) return null;
  if (typeof c.source !== "string" || !validRelativeSource(c.source) || typeof c.digest !== "string" || !/^[a-f0-9]{64}$/u.test(c.digest)) return null;
  if (c.sourceModifiedAt !== null && (typeof c.sourceModifiedAt !== "string" || !Number.isFinite(Date.parse(c.sourceModifiedAt)))) return null;
  if (typeof c.publishedAt !== "string" || !Number.isFinite(Date.parse(c.publishedAt))) return null;
  if (typeof c.publishingHost !== "string" || !c.publishingHost || c.publishingHost.length > 255 || /[/\\]/u.test(c.publishingHost)) return null;
  if (!c.status || !["ready", "empty", "missing", "unavailable"].includes(c.status)) return null;
  if (c.reason !== null && typeof c.reason !== "string") return null;
  if (!Number.isInteger(c.totalItems) || (c.totalItems ?? -1) < 0 || !Number.isInteger(c.openItems) || (c.openItems ?? -1) < 0) return null;
  if (typeof c.truncated !== "boolean" || !Array.isArray(c.items) || c.items.length > ROADMAP_MAX_ITEMS) return null;
  for (const item of c.items) {
    const i = item as Partial<RoadmapSnapshotItem>;
    if (!item || typeof item !== "object" || typeof i.id !== "string" || i.id.length > 80 || typeof i.title !== "string" || i.title.length > 240) return null;
    if (i.section !== null && (typeof i.section !== "string" || i.section.length > 160)) return null;
    if (!Number.isInteger(i.line) || (i.line ?? 0) < 1 || !["open", "done"].includes(i.status ?? "")) return null;
  }
  if (c.returnedItems !== undefined && (!Number.isInteger(c.returnedItems) || c.returnedItems !== c.items.length)) return null;
  if (c.capturedItems !== undefined && (!Number.isInteger(c.capturedItems) || c.capturedItems < c.items.length || c.capturedItems > ROADMAP_MAX_ITEMS)) return null;
  if (c.itemOffset !== undefined && (!Number.isInteger(c.itemOffset) || c.itemOffset < 0)) return null;
  if (c.itemLimit !== undefined && (!Number.isInteger(c.itemLimit) || c.itemLimit < 1 || c.itemLimit > ROADMAP_MAX_ITEMS)) return null;
  if (c.hasMore !== undefined && typeof c.hasMore !== "boolean") return null;
  if (c.nextOffset !== undefined && c.nextOffset !== null && (!Number.isInteger(c.nextOffset) || c.nextOffset < 1)) return null;
  if (c.sections !== undefined) {
    if (!Array.isArray(c.sections)) return null;
    for (const aggregate of c.sections) {
      const section = aggregate as Partial<RoadmapSnapshotSection>;
      if (!aggregate || typeof aggregate !== "object" || (section.section !== null && (typeof section.section !== "string" || section.section.length > 160))) return null;
      if (!Number.isInteger(section.totalItems) || !Number.isInteger(section.openItems) || !Number.isInteger(section.doneItems)) return null;
      if ((section.totalItems ?? -1) < 0 || (section.openItems ?? -1) < 0 || (section.doneItems ?? -1) < 0 || section.openItems! + section.doneItems! !== section.totalItems) return null;
    }
  }
  if (/\/(?:Users|home)\/|[A-Za-z]:\\/u.test(JSON.stringify(c))) return null;
  return {
    ...c,
    capturedItems: c.capturedItems ?? c.items.length,
    returnedItems: c.returnedItems ?? c.items.length,
    itemOffset: c.itemOffset ?? 0,
    itemLimit: c.itemLimit ?? (c.items.length || 1),
    hasMore: c.hasMore ?? c.truncated,
    nextOffset: c.nextOffset ?? null,
    sections: c.sections ?? sectionAggregates(c.items)
  } as RoadmapSnapshot;
}

export function serverRoadmapSnapshot(snapshot: RoadmapSnapshot, now = Date.now(), staleAfterSeconds = ROADMAP_STALE_AFTER_SECONDS): ServerRoadmapSnapshot {
  const published = Date.parse(snapshot.publishedAt);
  const ageSeconds = Number.isFinite(published) ? Math.max(0, Math.floor((now - published) / 1000)) : null;
  const freshness = snapshot.status === "missing" || snapshot.status === "unavailable" ? "missing" : ageSeconds === null ? "invalid" : ageSeconds > staleAfterSeconds ? "stale" : "current";
  return { ...snapshot, freshness, ageSeconds };
}
