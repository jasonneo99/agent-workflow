import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type TrainingDiscoverySource = {
  id: string;
  url: string;
  publisher: string;
  publishedOrUpdated: string;
  license: string;
  targets: string[];
  claimedBenefit: string;
  confidence: "medium" | "medium-high" | "high";
  risks: string;
  holdoutEvaluation: string;
  expectedCost: string;
  rollbackPlan: string;
};

export type TrainingDiscoveryProposal = TrainingDiscoverySource & {
  retrievedAt: string;
  contentSha256: string;
  status: "proposed" | "changed";
};

export type TrainingProposalDecisionStatus = "pending" | "approved" | "rejected" | "stale" | "unsafe" | "evaluated" | "promoted";
export type TrainingProposalInboxItem = {
  id: string;
  sourceId: string;
  contentSha256: string;
  status: TrainingProposalDecisionStatus;
  createdAt: string;
  updatedAt: string;
  reviewer?: string;
  note?: string;
  proposal: TrainingDiscoveryProposal;
};
export type TrainingProposalInbox = { kind: "agentflow_training_proposal_inbox"; version: 1; updatedAt: string; items: TrainingProposalInboxItem[] };

export type TrainingDiscoveryReport = {
  kind: "agentflow_training_discovery_report";
  generatedAt: string;
  status: "completed" | "not_due" | "failed";
  projectRootUri: string;
  cadenceMs: number;
  nextRunAfter: string;
  roster: { agents: string[]; daemonLanes: string[] };
  coverage: { targets: string[]; rotationIndex: number };
  scannedSources: number;
  proposals: TrainingDiscoveryProposal[];
  staleSources: Array<{ id: string; url: string; reason: string }>;
  unsafeSources: Array<{ id: string; url: string; reason: string }>;
  contradictoryEvidence: string[];
  errors: string[];
};

type TrainingDiscoveryState = {
  kind: "agentflow_training_discovery_state";
  lastRunAt: string | null;
  rotationIndex: number;
  sourceHashes: Record<string, string>;
};

export const officialTrainingSources: TrainingDiscoverySource[] = [
  {
    id: "otel-genai-agent-spans",
    url: "https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md",
    publisher: "OpenTelemetry",
    publishedOrUpdated: "continuously maintained; Development status",
    license: "Apache-2.0",
    targets: ["routing-optimizer", "backend-engineer", "evidence-collector"],
    claimedBenefit: "Standardize privacy-bounded telemetry for agent, workflow, plan, and tool execution.",
    confidence: "medium-high",
    risks: "The conventions are not stable and optional payload capture can expose sensitive content.",
    holdoutEvaluation: "Trace synthetic nested-agent, retry, tool-failure, and recovery cases; require correct parentage, bounded cardinality, and zero raw secrets.",
    expectedCost: "Low token impact and modest telemetry volume.",
    rollbackPlan: "Retain the internal event schema and remove the mapping if compatibility tests fail."
  },
  {
    id: "slsa-source-requirements",
    url: "https://slsa.dev/spec/v1.2/source-requirements",
    publisher: "OpenSSF SLSA project",
    publishedOrUpdated: "SLSA specification v1.2",
    license: "Community Specification License 1.0",
    targets: ["pr-preparer", "release-manager", "repository-steward", "release-ci-guardian"],
    claimedBenefit: "Improve review of revision identity, provenance, attribution, and enforced branch controls.",
    confidence: "high",
    risks: "Maturity guidance must not be represented as certification or added as empty ceremony.",
    holdoutEvaluation: "Seed tampered revisions, missing provenance, unauthenticated attribution, and a valid attested build; measure detection and review time.",
    expectedCost: "Low recurring checklist cost and medium initial fixture work.",
    rollbackPlan: "Keep the checks advisory and remove them if latency rises without better defect detection."
  },
  {
    id: "w3c-wcag22-understanding",
    url: "https://www.w3.org/WAI/WCAG22/understanding/",
    publisher: "W3C Web Accessibility Initiative",
    publishedOrUpdated: "updated 2026-02-11",
    license: "W3C document terms",
    targets: ["frontend-engineer", "ux-reviewer", "auto-test-runner"],
    claimedBenefit: "Improve dashboard reviews for focus, reflow, target size, redundant entry, status messages, and accessible authentication.",
    confidence: "high",
    risks: "Automation alone cannot prove conformance and AAA criteria must not be mislabeled as AA requirements.",
    holdoutEvaluation: "Exercise keyboard-only, zoom/reflow, collapsed navigation, approval, authentication, and asynchronous status flows with automated and manual evidence.",
    expectedCost: "Low token impact and medium browser-test time.",
    rollbackPlan: "Remove flaky holdouts while preserving confirmed defects as ordinary regressions."
  },
  {
    id: "postgresql-advisory-locks",
    url: "https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS",
    publisher: "PostgreSQL Global Development Group",
    publishedOrUpdated: "current documentation",
    license: "PostgreSQL documentation license",
    targets: ["database-engineer", "runtime-maintenance", "backup-recovery-verifier"],
    claimedBenefit: "Strengthen lease, fencing, and recovery reasoning around transaction- and session-scoped advisory locks.",
    confidence: "high",
    risks: "Advisory locks are cooperative and can create deadlocks or misleading safety assumptions when used inconsistently.",
    holdoutEvaluation: "Simulate concurrent claims, rollback, connection loss, stale sessions, ordering, and bounded recovery without split-brain writes.",
    expectedCost: "Low token cost and medium integration-test time.",
    rollbackPlan: "Retain existing lease primitives and remove advisory-lock guidance if contention or recovery behavior regresses."
  },
  {
    id: "node-test-runner",
    url: "https://nodejs.org/api/test.html",
    publisher: "Node.js project",
    publishedOrUpdated: "current API documentation",
    license: "MIT documentation source",
    targets: ["test-engineer", "ci-debugger", "auto-test-runner", "auto-ci-triage"],
    claimedBenefit: "Improve deterministic test isolation, mocking, concurrency, sharding, and failure diagnostics using the native runner.",
    confidence: "high",
    risks: "Examples may depend on a newer Node release than a downstream project supports.",
    holdoutEvaluation: "Compare flaky concurrent fixtures, timer mocks, process isolation, and shard aggregation across the minimum supported Node version.",
    expectedCost: "Low token impact and potentially lower CI dependency cost.",
    rollbackPlan: "Keep existing test commands and revert only the new runner patterns that fail compatibility holdouts."
  },
  {
    id: "github-actions-security",
    url: "https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions",
    publisher: "GitHub",
    publishedOrUpdated: "continuously maintained official documentation",
    license: "GitHub documentation terms; concepts only",
    targets: ["security-reviewer", "ci-debugger", "release-ci-guardian", "auto-release-check"],
    claimedBenefit: "Improve detection of untrusted input, excessive token permissions, mutable action references, and provenance gaps in CI.",
    confidence: "high",
    risks: "GitHub-specific controls must not be assumed portable to other CI providers.",
    holdoutEvaluation: "Seed expression injection, broad permissions, unpinned actions, and unsafe pull-request triggers; require provider-aware findings without false portability claims.",
    expectedCost: "Low recurring review cost and medium security-fixture work.",
    rollbackPlan: "Remove provider-specific checks from generic agents while retaining them in GitHub-scoped evaluation fixtures."
  }
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function statePath(projectDir: string): string {
  return path.join(projectDir, ".agent-workflow", "learning", "training-discovery", "state.json");
}

function reportPaths(projectDir: string): { json: string; markdown: string } {
  const dir = path.join(projectDir, ".agent-workflow", "learning", "training-discovery");
  return { json: path.join(dir, "latest.json"), markdown: path.join(dir, "latest.md") };
}

function discoveryDir(projectDir: string): string {
  return path.join(projectDir, ".agent-workflow", "learning", "training-discovery");
}

function inboxPath(projectDir: string): string {
  return path.join(discoveryDir(projectDir), "inbox.json");
}

type TrainingSourceRegistry = {
  version: 1;
  allowedDomains?: string[];
  sources?: TrainingDiscoverySource[];
};

async function loadTrainingSourceRegistry(projectDir: string): Promise<TrainingSourceRegistry> {
  const registryPath = path.join(projectDir, ".agent-workflow", "training-sources.json");
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as TrainingSourceRegistry;
    if (parsed.version !== 1) throw new Error("training source registry must use version 1");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
}

export async function readTrainingProposalInbox(projectDir: string): Promise<TrainingProposalInbox> {
  try {
    const parsed = JSON.parse(await fs.readFile(inboxPath(projectDir), "utf8")) as TrainingProposalInbox;
    if (parsed.kind === "agentflow_training_proposal_inbox" && parsed.version === 1 && Array.isArray(parsed.items)) return parsed;
  } catch {
    // Missing local inbox is an empty inbox.
  }
  return { kind: "agentflow_training_proposal_inbox", version: 1, updatedAt: new Date(0).toISOString(), items: [] };
}

export async function decideTrainingProposal(input: { projectDir: string; id: string; status: Exclude<TrainingProposalDecisionStatus, "pending">; reviewer: string; note?: string; now?: Date }): Promise<TrainingProposalInbox> {
  const inbox = await readTrainingProposalInbox(input.projectDir);
  const updatedAt = (input.now ?? new Date()).toISOString();
  const item = inbox.items.find((candidate) => candidate.id === input.id);
  if (!item) throw new Error(`Unknown training proposal: ${input.id}`);
  item.status = input.status;
  item.updatedAt = updatedAt;
  item.reviewer = input.reviewer;
  item.note = input.note;
  inbox.updatedAt = updatedAt;
  await fs.writeFile(inboxPath(input.projectDir), `${JSON.stringify(inbox, null, 2)}\n`, "utf8");
  await appendReceipt(input.projectDir, { at: updatedAt, event: "decision", proposalId: item.id, sourceId: item.sourceId, contentSha256: item.contentSha256, status: item.status, reviewer: input.reviewer, note: input.note });
  return inbox;
}

async function appendReceipt(projectDir: string, receipt: Record<string, unknown>): Promise<void> {
  const receiptPath = path.join(discoveryDir(projectDir), "receipts.jsonl");
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  const existing = await fs.readFile(receiptPath, "utf8").catch(() => "");
  const lines = [...existing.split("\n").filter(Boolean), JSON.stringify(receipt)].slice(-500);
  await fs.writeFile(receiptPath, `${lines.join("\n")}\n`, "utf8");
}

function suspiciousExternalContent(content: string): boolean {
  return /ignore\s+(all\s+)?previous\s+instructions|<system(?:\s|>)|exfiltrat(?:e|ion)|reveal\s+(?:the\s+)?(?:system|developer)\s+prompt/iu.test(content);
}

export async function readLatestTrainingDiscoveryReport(projectDir: string): Promise<TrainingDiscoveryReport | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(reportPaths(projectDir).json, "utf8")) as TrainingDiscoveryReport;
    return parsed.kind === "agentflow_training_discovery_report" ? parsed : null;
  } catch {
    return null;
  }
}

async function readState(projectDir: string): Promise<TrainingDiscoveryState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(projectDir), "utf8")) as TrainingDiscoveryState;
    if (parsed.kind === "agentflow_training_discovery_state") return parsed;
  } catch {
    // First run or invalid disposable local state.
  }
  return { kind: "agentflow_training_discovery_state", lastRunAt: null, rotationIndex: 0, sourceHashes: {} };
}

export function formatTrainingDiscoveryReport(report: TrainingDiscoveryReport): string {
  return [
    "# Agent Training Discovery",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Next run after: ${report.nextRunAfter}`,
    `Coverage rotation: ${report.coverage.targets.join(", ") || "none"}`,
    `Roster: ${report.roster.agents.length} agents; ${report.roster.daemonLanes.length} daemon lanes`,
    "",
    "## Proposals",
    ...(report.proposals.length ? report.proposals.flatMap((proposal) => [
      `### ${proposal.id}`,
      "",
      `- Status: ${proposal.status}`,
      `- Source: ${proposal.url}`,
      `- Publisher: ${proposal.publisher}`,
      `- Publication/update: ${proposal.publishedOrUpdated}`,
      `- Retrieved: ${proposal.retrievedAt}`,
      `- Content SHA-256: ${proposal.contentSha256}`,
      `- Targets: ${proposal.targets.join(", ")}`,
      `- Claimed benefit: ${proposal.claimedBenefit}`,
      `- Confidence: ${proposal.confidence}`,
      `- Risks: ${proposal.risks}`,
      `- License/reuse: ${proposal.license}`,
      `- Holdout: ${proposal.holdoutEvaluation}`,
      `- Expected token/cost impact: ${proposal.expectedCost}`,
      `- Rollback: ${proposal.rollbackPlan}`,
      ""
    ]) : ["- none", ""]),
    "## Source health",
    ...(report.staleSources.length ? report.staleSources.map((source) => `- ${source.id}: ${source.reason} (${source.url})`) : ["- no stale sources detected"]),
    ...(report.unsafeSources.length ? ["", "## Quarantined sources", ...report.unsafeSources.map((source) => `- ${source.id}: ${source.reason} (${source.url})`)] : []),
    ...(report.errors.length ? ["", "## Errors", ...report.errors.map((error) => `- ${error}`)] : []),
    ""
  ].join("\n");
}

export async function runTrainingDiscovery(input: {
  projectDir: string;
  agents: string[];
  daemonLanes: string[];
  cadenceMs?: number;
  force?: boolean;
  now?: Date;
  fetcher?: typeof fetch;
  sources?: TrainingDiscoverySource[];
  rotationSize?: number;
  allowedDomains?: string[];
  rateLimitMs?: number;
}): Promise<TrainingDiscoveryReport> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const cadenceMs = input.cadenceMs ?? 86_400_000;
  const registry = input.sources ? { version: 1 as const } : await loadTrainingSourceRegistry(input.projectDir);
  const sources = input.sources ?? [...officialTrainingSources, ...(registry.sources ?? [])].filter((source, index, items) => items.findIndex((candidate) => candidate.id === source.id) === index);
  const state = await readState(input.projectDir);
  const lastRun = state.lastRunAt ? Date.parse(state.lastRunAt) : Number.NaN;
  const due = input.force === true || !Number.isFinite(lastRun) || now.getTime() - lastRun >= cadenceMs;
  const rosterTargets = [...new Set([...input.agents, ...input.daemonLanes])].sort();
  const rotationSize = Math.max(1, input.rotationSize ?? 8);
  const rotationIndex = rosterTargets.length ? state.rotationIndex % rosterTargets.length : 0;
  const coverageTargets = rosterTargets.length
    ? Array.from({ length: Math.min(rotationSize, rosterTargets.length) }, (_, index) => rosterTargets[(rotationIndex + index) % rosterTargets.length])
    : [];
  const nextRunAfter = new Date((due ? now.getTime() : lastRun) + cadenceMs).toISOString();
  const report: TrainingDiscoveryReport = {
    kind: "agentflow_training_discovery_report",
    generatedAt,
    status: due ? "completed" : "not_due",
    projectRootUri: input.projectDir,
    cadenceMs,
    nextRunAfter,
    roster: { agents: [...input.agents].sort(), daemonLanes: [...input.daemonLanes].sort() },
    coverage: { targets: coverageTargets, rotationIndex },
    scannedSources: 0,
    proposals: [],
    staleSources: [],
    unsafeSources: [],
    contradictoryEvidence: [],
    errors: []
  };
  if (due) {
    const fetcher = input.fetcher ?? fetch;
    const allowedDomains = new Set((input.allowedDomains ?? registry.allowedDomains ?? sources.map((source) => new URL(source.url).hostname)).map((domain) => domain.toLowerCase()));
    const robots = new Map<string, string>();
    const inbox = await readTrainingProposalInbox(input.projectDir);
    const relevantSources = sources.filter((source) => source.targets.some((target) => coverageTargets.includes(target)));
    for (const source of relevantSources) {
      try {
        const sourceUrl = new URL(source.url);
        if (sourceUrl.protocol !== "https:" || !allowedDomains.has(sourceUrl.hostname.toLowerCase())) throw new Error("source domain is not allowlisted");
        let robotsText = robots.get(sourceUrl.origin);
        if (robotsText === undefined) {
          const robotsResponse = await fetcher(`${sourceUrl.origin}/robots.txt`, { headers: { "user-agent": "Agent-Workflow-Training-Discovery/1.0" }, signal: AbortSignal.timeout(5_000) });
          robotsText = robotsResponse.ok ? await robotsResponse.text() : "";
          robots.set(sourceUrl.origin, robotsText);
        }
        const disallowed = robotsText.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^disallow:/iu.test(line)).map((line) => line.slice(line.indexOf(":") + 1).trim()).filter(Boolean);
        if (disallowed.some((prefix) => sourceUrl.pathname.startsWith(prefix))) throw new Error("source path is disallowed by robots.txt");
        const response = await fetcher(source.url, { headers: { "user-agent": "Agent-Workflow-Training-Discovery/1.0" }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const content = await response.text();
        if (content.length > 2_000_000) throw new Error("source exceeds 2 MB evidence budget");
        const contentSha256 = sha256(content);
        if (suspiciousExternalContent(content)) {
          report.unsafeSources.push({ id: source.id, url: source.url, reason: "source contains instruction-like or exfiltration language and was quarantined" });
          const unsafeProposal: TrainingDiscoveryProposal = { ...source, publishedOrUpdated: response.headers.get("last-modified") ?? source.publishedOrUpdated, retrievedAt: generatedAt, contentSha256, status: state.sourceHashes[source.id] ? "changed" : "proposed" };
          const unsafeId = `${source.id}:${contentSha256.slice(0, 16)}`;
          const existingUnsafe = inbox.items.find((item) => item.id === unsafeId);
          if (!existingUnsafe) inbox.items.push({ id: unsafeId, sourceId: source.id, contentSha256, status: "unsafe", createdAt: generatedAt, updatedAt: generatedAt, proposal: unsafeProposal });
          await appendReceipt(input.projectDir, { at: generatedAt, event: "quarantined", proposalId: unsafeId, sourceId: source.id, contentSha256, status: "unsafe" });
          state.sourceHashes[source.id] = contentSha256;
          report.scannedSources += 1;
          continue;
        }
        const previousHash = state.sourceHashes[source.id];
        state.sourceHashes[source.id] = contentSha256;
        report.scannedSources += 1;
        if (!previousHash || previousHash !== contentSha256) {
          const proposal: TrainingDiscoveryProposal = { ...source, publishedOrUpdated: response.headers.get("last-modified") ?? source.publishedOrUpdated, retrievedAt: generatedAt, contentSha256, status: previousHash ? "changed" : "proposed" };
          report.proposals.push(proposal);
          const id = `${source.id}:${contentSha256.slice(0, 16)}`;
          if (!inbox.items.some((item) => item.id === id)) {
            inbox.items.push({ id, sourceId: source.id, contentSha256, status: "pending", createdAt: generatedAt, updatedAt: generatedAt, proposal });
            await appendReceipt(input.projectDir, { at: generatedAt, event: previousHash ? "source_changed" : "proposed", proposalId: id, sourceId: source.id, contentSha256, status: "pending" });
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.staleSources.push({ id: source.id, url: source.url, reason });
        report.errors.push(`${source.id}: ${reason}`);
      }
      if ((input.rateLimitMs ?? 25) > 0) await new Promise((resolve) => setTimeout(resolve, input.rateLimitMs ?? 25));
    }
    report.status = report.errors.length && report.scannedSources === 0 ? "failed" : "completed";
    state.lastRunAt = generatedAt;
    state.rotationIndex = rosterTargets.length ? (rotationIndex + coverageTargets.length) % rosterTargets.length : 0;
    inbox.updatedAt = generatedAt;
    await fs.mkdir(discoveryDir(input.projectDir), { recursive: true });
    await fs.writeFile(inboxPath(input.projectDir), `${JSON.stringify(inbox, null, 2)}\n`, "utf8");
  }
  if (due) {
    const paths = reportPaths(input.projectDir);
    await fs.mkdir(path.dirname(paths.json), { recursive: true });
    const previous = await readLatestTrainingDiscoveryReport(input.projectDir);
    if (previous && previous.generatedAt !== report.generatedAt) {
      const historyDir = path.join(discoveryDir(input.projectDir), "history");
      await fs.mkdir(historyDir, { recursive: true });
      const stamp = previous.generatedAt.replace(/[:.]/gu, "-");
      await fs.writeFile(path.join(historyDir, `${stamp}.json`), `${JSON.stringify(previous, null, 2)}\n`, "utf8");
    }
    await fs.writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(paths.markdown, formatTrainingDiscoveryReport(report), "utf8");
    await fs.writeFile(statePath(input.projectDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  return report;
}
