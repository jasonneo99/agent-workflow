import { createHash } from "node:crypto";

export type EvidenceKind = "source" | "requirement" | "roadmap" | "decision" | "run" | "artifact" | "failure" | "agent";
export interface EvidenceEntry { kind: "requirement" | "roadmap" | "decision"; title: string; line: number }
export interface EvidenceNode {
  id: string; kind: EvidenceKind; title: string;
  source: { table: string; key: string; path?: string; line?: number; hash?: string };
  observedAt: string | null; freshness: "unverified" | "historical";
  confidence: "recorded" | "extracted"; authority: "none";
  target: { type: "file" | "run"; value: string; line?: number };
}
export interface EvidenceRelationship {
  id: string; from: string; to: string; type: "contains" | "produced" | "failed" | "participated";
  source: { table: string; key: string }; authority: "none";
}
export interface ProjectEvidenceGraph {
  schemaVersion: 1; project: string; generatedAt: string; authority: "none";
  status: "available" | "empty" | "unavailable"; truncated: boolean;
  nodes: EvidenceNode[]; relationships: EvidenceRelationship[]; warnings: string[];
}
export interface EvidenceRecords {
  files: { sourceUri: string; contentHash: string; updatedAt: string; metadata: Record<string, unknown> }[];
  runs: { id: string; task: string; status: string; updatedAt: string }[];
  artifacts: { id: string; runId: string; kind: string; createdAt: string }[];
  tasks: { id: string; runId: string; agentId: string | null; status: string; finishedAt: string | null }[];
}
const identity = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Only explicit document structure is extracted. Text never becomes authority. */
export function extractEvidenceEntries(sourceUri: string, content: string): EvidenceEntry[] {
  const kind = /(?:^|\/)(?:requirements?)[^/]*\.md$/i.test(sourceUri) ? "requirement"
    : /(?:^|\/)roadmap\.md$/i.test(sourceUri) ? "roadmap"
    : /(?:^|\/)decisions\.md$/i.test(sourceUri) ? "decision" : null;
  if (!kind) return [];
  const entries: EvidenceEntry[] = [];
  let fenced = false;
  for (const [i, line] of content.split(/\r?\n/u).entries()) {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^(?:#{2,6}\s+|\s*[-*]\s+\[[ xX]\]\s+)(.+)$/u.exec(line);
    if (match) entries.push({ kind, title: match[1].slice(0, 500), line: i + 1 });
    if (entries.length >= 200) break;
  }
  return entries;
}

export function buildProjectEvidenceGraph(project: string, records: EvidenceRecords, options: { generatedAt?: string; truncated?: boolean } = {}): ProjectEvidenceGraph {
  const nodes: EvidenceNode[] = [], relationships: EvidenceRelationship[] = [];
  let extracted = 0;
  let truncated = options.truncated ?? false;
  const entryIds = new Set<string>();
  const id = (kind: string, key: string) => identity(project, kind, key);
  const edge = (from: string, to: string, type: EvidenceRelationship["type"], table: string, key: string) => {
    relationships.push({ id: identity(from, to, type, key), from, to, type, source: { table, key }, authority: "none" });
  };
  for (const file of records.files) {
    // Reject external paths and runtime/private material even if a legacy index contains it.
    if (!safeEvidencePath(file.sourceUri)) continue;
    const sourceId = id("source", file.sourceUri);
    const base = { observedAt: file.updatedAt, freshness: "unverified" as const, authority: "none" as const };
    nodes.push({ ...base, id: sourceId, kind: "source", title: file.sourceUri, confidence: "recorded", source: { table: "project_files", key: file.sourceUri, path: file.sourceUri, hash: file.contentHash }, target: { type: "file", value: file.sourceUri } });
    const entries = file.metadata.evidenceEntries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries.slice(0, 200)) {
      if (!entry || !["requirement", "roadmap", "decision"].includes(entry.kind) || typeof entry.title !== "string" || !Number.isSafeInteger(entry.line) || entry.line < 1) continue;
      const entryId = id(entry.kind, `${file.sourceUri}:${entry.line}`);
      if (entryIds.has(entryId)) continue;
      if (extracted >= 2000) { truncated = true; continue; }
      entryIds.add(entryId); extracted += 1;
      nodes.push({ ...base, id: entryId, kind: entry.kind, title: entry.title.slice(0, 500), confidence: "extracted", source: { table: "project_files", key: file.sourceUri, path: file.sourceUri, line: entry.line, hash: file.contentHash }, target: { type: "file", value: file.sourceUri, line: entry.line } });
      edge(sourceId, entryId, "contains", "project_files", file.sourceUri);
    }
  }
  const runIds = new Set(records.runs.map(run => run.id));
  for (const run of records.runs) {
    nodes.push({ id: id("run", run.id), kind: "run", title: run.task.slice(0, 500), observedAt: run.updatedAt, freshness: "historical", confidence: "recorded", authority: "none", source: { table: "workflow_runs", key: run.id }, target: { type: "run", value: run.id } });
  }
  for (const artifact of records.artifacts) {
    if (!runIds.has(artifact.runId)) continue;
    const artifactId = id("artifact", artifact.id);
    nodes.push({ id: artifactId, kind: "artifact", title: artifact.kind, observedAt: artifact.createdAt, freshness: "historical", confidence: "recorded", authority: "none", source: { table: "artifacts", key: artifact.id }, target: { type: "run", value: artifact.runId } });
    edge(id("run", artifact.runId), artifactId, "produced", "artifacts", artifact.id);
  }
  const agents = new Set<string>();
  for (const task of records.tasks) {
    if (!runIds.has(task.runId)) continue;
    if (task.agentId) {
      const agentId = id("agent", task.agentId);
      if (!agents.has(agentId)) nodes.push({ id: agentId, kind: "agent", title: task.agentId, observedAt: null, freshness: "historical", confidence: "recorded", authority: "none", source: { table: "workflow_tasks", key: task.id }, target: { type: "run", value: task.runId } });
      agents.add(agentId);
      edge(agentId, id("run", task.runId), "participated", "workflow_tasks", task.id);
    }
    if (task.status === "failed") {
      const failureId = id("failure", task.id);
      nodes.push({ id: failureId, kind: "failure", title: `Failed task: ${task.agentId ?? "unassigned"}`, observedAt: task.finishedAt, freshness: "historical", confidence: "recorded", authority: "none", source: { table: "workflow_tasks", key: task.id }, target: { type: "run", value: task.runId } });
      edge(id("run", task.runId), failureId, "failed", "workflow_tasks", task.id);
    }
  }
  return { schemaVersion: 1, project, generatedAt: options.generatedAt ?? new Date().toISOString(), authority: "none", status: nodes.length ? "available" : "empty", truncated, nodes, relationships, warnings: ["Indexed files have not been compared with current disk contents. Historical run evidence does not establish current project state.", "Older source indexes need an index refresh to expose structured requirements, roadmap items and decisions."] };
}

export function safeEvidencePath(value: string): boolean {
  return value.length > 0 && !/^[\\/]|^[a-z]+:|[\\\x00-\x1f]/i.test(value)
    && !value.split("/").some(segment => segment === ".." || segment === ".git" || segment === "node_modules" || /^\.env(?:\.|$)/u.test(segment))
    && !/^\.agent-workflow\/(?!decisions\.md$|context\.md$|commands\.md$)/u.test(value);
}
