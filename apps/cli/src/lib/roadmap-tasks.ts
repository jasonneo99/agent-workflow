// Roadmap markdown parsing used by the dashboard, moved out of daemon.ts
// without changes.
import type { RoadmapMilestone, RoadmapPriority, RoadmapTask, RoadmapTaskKind, RoadmapTaskStatus } from "../commands/daemon-types.js";

export function cleanRoadmapFormText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/[<>]/gu, "");
}

export function cleanRoadmapTaskTitle(value: string): string {
  return value.replace(/\s+$/u, "").replace(/\.$/u, "");
}

export function roadmapPriorityOrder(): RoadmapPriority[] {
  return ["critical", "high", "medium", "low"];
}

export function roadmapPriorityRank(priority: RoadmapPriority): number {
  return roadmapPriorityOrder().indexOf(priority);
}

export function roadmapTaskId(title: string, line: number): string {
  return `${line}-${title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60)}`;
}

export function parseRoadmapPriority(value: string): RoadmapPriority | null {
  const normalized = value.trim().toLowerCase();
  return roadmapPriorityOrder().includes(normalized as RoadmapPriority) ? normalized as RoadmapPriority : null;
}

export function compareRoadmapTasks(a: RoadmapTask, b: RoadmapTask): number {
  const priority = roadmapPriorityRank(a.priority) - roadmapPriorityRank(b.priority);
  if (priority !== 0) return priority;
  const statusA = a.status === "next" ? 0 : a.status === "open" ? 1 : 2;
  const statusB = b.status === "next" ? 0 : b.status === "open" ? 1 : 2;
  if (statusA !== statusB) return statusA - statusB;
  return a.sourceLine - b.sourceLine;
}

export function inferRoadmapMilestoneNumber(title: string, phase: string, details: string[]): number | null {
  const haystack = `${title} ${phase} ${details.join(" ")}`.toLowerCase();
  if (/\bmcp\b|codex|cursor|vs code|\bide\b|stdio|transport/u.test(haystack)) return 12;
  if (/signed|trusted|registry|npm|publish|release|backup|restore|disaster|bundle/u.test(haystack)) return 11;
  if (/launchagent|supervisor|worker|run-and-watch|startup|stale process|durable workflow/u.test(haystack)) return 10;
  if (/server mode|authenticated|http|rate limit|remote|request envelope|reverse proxy|tls/u.test(haystack)) return 9;
  if (/sharedHost|shared storage|offline|sync|state plane|migration|cross-machine|alias|object storage/u.test(haystack)) return 8;
  if (/agent improvement|promotion|holdout|yaml patch|self-improv|agent definition/u.test(haystack)) return 7;
  if (/learning|daemon|proposal|workflow shape|discovery|feedback memory/u.test(haystack)) return 6;
  if (/model|provider|routing|catalog|token|cost|quality|tuning|eval/u.test(haystack)) return 5;
  if (/approval|autonomy|policy|role|governance|safety|permission|gate/u.test(haystack)) return 4;
  if (/dashboard|graph|gantt|roadmap|ux|visual|navigation|settings|surface/u.test(haystack)) return 3;
  if (/postgres|pgvector|redis|minio|enterprise storage|durable|receipt|artifact/u.test(haystack)) return 2;
  if (/portable|workflow authoring|template|schema|cli|core|project onboarding/u.test(haystack)) return 1;
  return null;
}

export function inferRoadmapPriority(title: string, phase: string, details: string[], kind: RoadmapTaskKind, status: RoadmapTaskStatus): RoadmapPriority {
  const explicit = details.map((detail) => detail.match(/^Priority:\s*(critical|high|medium|low)/iu)?.[1]).find(Boolean);
  if (explicit) return explicit.toLowerCase() as RoadmapPriority;
  if (status === "done") return "low";
  const haystack = `${title} ${phase} ${details.join(" ")}`.toLowerCase();
  if (kind === "bug" && /transport closed|data loss|secret|security|production|destructive|auth/u.test(haystack)) return "high";
  if (/next:|next best|high priority|server mode|shared storage|approval|mcp|transport|production/u.test(haystack)) return "high";
  if (/dashboard|learning|model|routing|eval|provider|autonomy|offline|sync/u.test(haystack)) return "medium";
  return "low";
}

export function parseRoadmapMilestones(lines: string[]): RoadmapMilestone[] {
  const milestones: RoadmapMilestone[] = [];
  let current: RoadmapMilestone | null = null;
  let inMilestoneMap = false;
  let continuation: "workstreams" | "status" | null = null;
  for (const line of lines) {
    if (line.startsWith("## Milestone Map")) {
      inMilestoneMap = true;
      continue;
    }
    if (inMilestoneMap && line.startsWith("## ") && !line.startsWith("## Milestone Map")) break;
    if (!inMilestoneMap) continue;
    const match = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*/u);
    if (match) {
      current = { number: Number(match[1]), title: match[2], workstreams: [], status: "" };
      milestones.push(current);
      continuation = null;
      continue;
    }
    if (!current) continue;
    const workstream = line.match(/^\s+-\s+Workstreams:\s+(.+)$/u);
    if (workstream) {
      current.workstreams = workstream[1].split(",").map((item) => item.trim().replace(/\.$/u, "")).filter(Boolean);
      continuation = "workstreams";
      continue;
    }
    const status = line.match(/^\s+-\s+Current status:\s+(.+)$/u);
    if (status) {
      current.status = status[1];
      continuation = "status";
      continue;
    }
    if (continuation && /^\s{5,}\S/u.test(line)) {
      if (continuation === "status") current.status = `${current.status} ${line.trim()}`.trim();
      if (continuation === "workstreams") {
        current.workstreams = `${current.workstreams.join(", ")} ${line.trim()}`
          .split(",")
          .map((item) => item.trim().replace(/\.$/u, ""))
          .filter(Boolean);
      }
      continue;
    }
    if (line.trim() === "") continuation = null;
  }
  return milestones;
}

export function parseRoadmapTasks(lines: string[], milestoneByNumber: Map<number, RoadmapMilestone>): RoadmapTask[] {
  const tasks: RoadmapTask[] = [];
  let phase = "Unassigned";
  let activeTask: RoadmapTask | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const phaseMatch = line.match(/^##\s+(.+)$/u);
    if (phaseMatch) {
      phase = phaseMatch[1];
      activeTask = null;
      continue;
    }
    const checklist = line.match(/^- \[(x| )\]\s+(.+)$/iu);
    if (checklist) {
      const title = cleanRoadmapTaskTitle(checklist[2]);
      const kind: RoadmapTaskKind = /^Bug:/iu.test(title) ? "bug" : "task";
      const milestoneNumber = inferRoadmapMilestoneNumber(title, phase, []);
      const milestone = milestoneNumber ? milestoneByNumber.get(milestoneNumber) ?? null : null;
      activeTask = {
        id: roadmapTaskId(title, index + 1),
        kind,
        status: checklist[1].toLowerCase() === "x" ? "done" : "open",
        phase,
        title,
        milestoneNumber: milestone?.number ?? milestoneNumber,
        milestoneTitle: milestone?.title ?? null,
        milestoneSource: milestoneNumber ? "inferred" : "missing",
        priority: inferRoadmapPriority(title, phase, [], kind, checklist[1].toLowerCase() === "x" ? "done" : "open"),
        sourceLine: index + 1,
        details: []
      };
      tasks.push(activeTask);
      continue;
    }
    if (!activeTask) continue;
    const detail = line.match(/^\s+-\s+(.+)$/u);
    if (!detail) continue;
    activeTask.details.push(detail[1]);
    const explicitMilestone = detail[1].match(/^Milestone:\s*(\d+)/iu);
      if (explicitMilestone) {
        const milestone = milestoneByNumber.get(Number(explicitMilestone[1])) ?? null;
        activeTask.milestoneNumber = milestone?.number ?? Number(explicitMilestone[1]);
        activeTask.milestoneTitle = milestone?.title ?? activeTask.milestoneTitle;
        activeTask.milestoneSource = "explicit";
      }
      const explicitPriority = detail[1].match(/^Priority:\s*(critical|high|medium|low)/iu);
      if (explicitPriority) activeTask.priority = explicitPriority[1].toLowerCase() as RoadmapPriority;
      const next = detail[1].match(/^Next:\s+(.+)$/iu);
      if (next) {
        const nextTitle = cleanRoadmapTaskTitle(next[1]);
        const inferred = inferRoadmapMilestoneNumber(nextTitle, phase, activeTask.details) ?? activeTask.milestoneNumber;
        const milestone = inferred ? milestoneByNumber.get(inferred) ?? null : null;
        const nextKind: RoadmapTaskKind = /^Bug:/iu.test(nextTitle) ? "bug" : "task";
        tasks.push({
          id: roadmapTaskId(nextTitle, index + 1),
          kind: nextKind,
          status: "next",
          phase,
          title: nextTitle,
          milestoneNumber: milestone?.number ?? inferred,
          milestoneTitle: milestone?.title ?? null,
          milestoneSource: inferred ? "inferred" : "missing",
          priority: inferRoadmapPriority(nextTitle, phase, activeTask.details, nextKind, "next"),
          sourceLine: index + 1,
          details: [`Parent: ${activeTask.title}`]
        });
    }
  }
  return tasks.map((task) => {
    if (task.milestoneNumber) return task;
    const inferred = inferRoadmapMilestoneNumber(task.title, task.phase, task.details);
    const milestone = inferred ? milestoneByNumber.get(inferred) ?? null : null;
    return {
      ...task,
      milestoneNumber: milestone?.number ?? inferred,
      milestoneTitle: milestone?.title ?? null,
      milestoneSource: inferred ? "inferred" : "missing"
    };
  });
}
