import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveContainedProjectPath } from "../../roadmap-planner/src/index.js";

export const ROADMAP_MAX_BYTES = 1_000_000;
export const ROADMAP_MAX_ITEMS = 500;
export const ROADMAP_STALE_AFTER_SECONDS = 86_400;

export type RoadmapSnapshotItem = { id: string; title: string; section: string | null; line: number; status: "open" | "done" };
export type RoadmapSnapshot = {
  version: 1; projectId: string; projectName: string; source: string; digest: string;
  sourceModifiedAt: string | null; publishedAt: string; publishingHost: string;
  status: "ready" | "empty" | "missing" | "unavailable"; reason: string | null;
  totalItems: number; openItems: number; truncated: boolean; items: RoadmapSnapshotItem[];
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

export function buildRoadmapSnapshot(input: {
  projectId: string; projectName: string; source: string; publishingHost: string; markdown?: string;
  sourceModifiedAt?: string; publishedAt?: string; status?: "missing" | "unavailable"; reason?: string; limit?: number;
}): RoadmapSnapshot {
  if (!validRelativeSource(input.source)) throw new Error("roadmap source must be a normalized project-relative path");
  const publishedAt = input.publishedAt ?? new Date().toISOString();
  const limit = Math.max(1, Math.min(input.limit ?? 200, ROADMAP_MAX_ITEMS));
  const allItems: RoadmapSnapshotItem[] = [];
  let section: string | null = null;
  if (input.markdown !== undefined) {
    for (const [index, line] of input.markdown.split(/\r?\n/u).entries()) {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*$/u);
      if (heading) section = boundedText(redactHostPaths(heading[1]), 160);
      const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/u);
      if (!task) continue;
      const title = boundedText(redactHostPaths(task[2]), 240);
      if (!title) continue;
      allItems.push({
        id: `roadmap-${createHash("sha256").update(`${input.source}:${index + 1}:${title}`).digest("hex").slice(0, 16)}`,
        title, section, line: index + 1, status: task[1].toLowerCase() === "x" ? "done" : "open"
      });
    }
  }
  const status = input.status ?? (allItems.length ? "ready" : "empty");
  return {
    version: 1, projectId: boundedText(input.projectId, 160), projectName: boundedText(input.projectName, 160), source: input.source,
    digest: createHash("sha256").update(input.markdown ?? "").digest("hex"), sourceModifiedAt: input.sourceModifiedAt ?? null,
    publishedAt, publishingHost: boundedText(input.publishingHost, 255), status,
    reason: input.reason ? boundedText(input.reason, 240) : null, totalItems: allItems.length,
    openItems: allItems.filter((item) => item.status === "open").length, truncated: allItems.length > limit, items: allItems.slice(0, limit)
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
  if (/\/(?:Users|home)\/|[A-Za-z]:\\/u.test(JSON.stringify(c))) return null;
  return c as RoadmapSnapshot;
}

export function serverRoadmapSnapshot(snapshot: RoadmapSnapshot, now = Date.now(), staleAfterSeconds = ROADMAP_STALE_AFTER_SECONDS): ServerRoadmapSnapshot {
  const published = Date.parse(snapshot.publishedAt);
  const ageSeconds = Number.isFinite(published) ? Math.max(0, Math.floor((now - published) / 1000)) : null;
  const freshness = snapshot.status === "missing" || snapshot.status === "unavailable" ? "missing" : ageSeconds === null ? "invalid" : ageSeconds > staleAfterSeconds ? "stale" : "current";
  return { ...snapshot, freshness, ageSeconds };
}
