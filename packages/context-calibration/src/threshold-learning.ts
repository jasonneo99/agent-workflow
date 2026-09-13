import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertContextProjectPath, type ContextRoutingPolicy } from "../../context-gateway/src/index.js";
import type { RepositoryCalibrationCase } from "./index.js";

export type ThresholdSegment = { language: string; fileType: string; stage: string; model: string };
export type ThresholdChange = { key: "direct_read_max_tokens" | "delegation_min_tokens"; current: number; proposed: number; reason: string };
export type SegmentedThresholdProposal = {
  id: string; segment: ThresholdSegment; sampleSize: number; qualityPassRate: number; citationPassRate: number; tokenSavingsPercent: number;
  status: "pending" | "approved" | "rejected" | "applied"; changes: ThresholdChange[]; evidenceHash: string; createdAt: string;
  decision?: { reviewer: string; note: string; decidedAt: string };
};
export type SegmentedThresholdQueue = { version: 1; projectHash: string; policyHash: string; proposals: SegmentedThresholdProposal[] };

export function buildSegmentedThresholdQueue(input: { projectIdentity: string; cases: RepositoryCalibrationCase[]; policy: ContextRoutingPolicy; minimumSamples?: number }): SegmentedThresholdQueue {
  const minimumSamples = Math.max(2, input.minimumSamples ?? 3);
  const groups = new Map<string, RepositoryCalibrationCase[]>();
  for (const item of input.cases) {
    const segment: ThresholdSegment = { language: item.language, fileType: item.fileType, stage: item.stage, model: item.model };
    const key = stableJson(segment);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const createdAt = new Date().toISOString();
  const proposals = [...groups.entries()].map(([segmentJson, cases]): SegmentedThresholdProposal => {
    const segment = JSON.parse(segmentJson) as ThresholdSegment;
    const qualityPassRate = ratio(cases.filter((item) => item.requiredTermsPresent).length, cases.length);
    const citationPassRate = ratio(cases.filter((item) => item.citationsValid).length, cases.length);
    const direct = cases.reduce((sum, item) => sum + item.directTokens, 0);
    const routed = cases.reduce((sum, item) => sum + item.routedTokens, 0);
    const tokenSavingsPercent = direct ? round((direct - routed) / direct * 100) : 0;
    const changes: ThresholdChange[] = [];
    if (cases.length >= minimumSamples) {
      if (qualityPassRate < 1 || citationPassRate < 1) changes.push({ key: "direct_read_max_tokens", current: input.policy.direct_read_max_tokens, proposed: Math.ceil(input.policy.direct_read_max_tokens * 1.25), reason: "Segment missed required context or citation evidence; widen direct reads conservatively." });
      else if (tokenSavingsPercent < 30) changes.push({ key: "delegation_min_tokens", current: input.policy.delegation_min_tokens, proposed: Math.max(input.policy.direct_read_max_tokens + 1, Math.floor(input.policy.delegation_min_tokens * 0.8)), reason: "Reviewed segment meets quality gates but needs broader low-risk routing eligibility." });
    }
    const evidenceHash = hash(stableJson(cases.map((item) => ({ id: item.id, fileHash: item.fileHash, contentHash: item.contentHash, route: item.route, requiredTermsPresent: item.requiredTermsPresent, citationsValid: item.citationsValid, directTokens: item.directTokens, routedTokens: item.routedTokens }))));
    return { id: `threshold-${hash(`${input.projectIdentity}:${segmentJson}:${evidenceHash}`).slice(0, 12)}`, segment, sampleSize: cases.length, qualityPassRate, citationPassRate, tokenSavingsPercent, status: "pending", changes, evidenceHash, createdAt };
  }).filter((item) => item.changes.length > 0);
  return { version: 1, projectHash: hash(input.projectIdentity), policyHash: hash(stableJson(input.policy)), proposals };
}

export async function writeSegmentedThresholdQueue(projectRoot: string, queue: SegmentedThresholdQueue): Promise<string> {
  const target = await queuePath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export async function readSegmentedThresholdQueue(projectRoot: string): Promise<SegmentedThresholdQueue | null> {
  try { return JSON.parse(await fs.readFile(await queuePath(projectRoot), "utf8")) as SegmentedThresholdQueue; } catch { return null; }
}

export async function decideSegmentedThresholdProposal(input: { projectRoot: string; proposalId: string; decision: "approved" | "rejected"; reviewer: string; note?: string }): Promise<SegmentedThresholdQueue> {
  const target = await queuePath(input.projectRoot);
  const queue = JSON.parse(await fs.readFile(target, "utf8")) as SegmentedThresholdQueue;
  const proposal = queue.proposals.find((item) => item.id === input.proposalId);
  if (!proposal) throw new Error(`Unknown threshold proposal: ${input.proposalId}`);
  if (proposal.status !== "pending") throw new Error(`Threshold proposal ${input.proposalId} is already ${proposal.status}.`);
  proposal.status = input.decision;
  proposal.decision = { reviewer: input.reviewer, note: input.note ?? "", decidedAt: new Date().toISOString() };
  await fs.writeFile(target, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  return queue;
}

export async function applyApprovedSegmentedThresholds(input: { projectRoot: string; proposalIds?: string[]; currentPolicy?: ContextRoutingPolicy }): Promise<{ applied: string[]; overlay: string; rollback: string }> {
  const target = await queuePath(input.projectRoot);
  const queue = JSON.parse(await fs.readFile(target, "utf8")) as SegmentedThresholdQueue;
  if (input.currentPolicy && hash(stableJson(input.currentPolicy)) !== queue.policyHash) throw new Error("Context routing policy changed after proposal generation; recalibrate before applying.");
  const selected = queue.proposals.filter((item) => item.status === "approved" && (!input.proposalIds?.length || input.proposalIds.includes(item.id)));
  if (!selected.length) throw new Error("No approved segmented threshold proposals were selected.");
  const directory = path.dirname(target);
  const overlay = path.join(directory, "approved-thresholds.json");
  const prior = await readOptional(overlay);
  const rollback = path.join(directory, `rollback-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.json`);
  await fs.writeFile(rollback, `${JSON.stringify({ version: 1, priorHash: prior ? hash(prior) : null, prior: prior ? JSON.parse(prior) : null, appliedProposalIds: selected.map((item) => item.id) }, null, 2)}\n`, { mode: 0o600 });
  const priorSegments = prior ? (JSON.parse(prior) as { segments?: unknown[] }).segments ?? [] : [];
  const selectedSegments = selected.map((item) => ({ proposalId: item.id, segment: item.segment, changes: item.changes, evidenceHash: item.evidenceHash, approvedBy: item.decision?.reviewer, approvedAt: item.decision?.decidedAt }));
  const selectedKeys = new Set(selectedSegments.map((item) => stableJson(item.segment)));
  const segments = [...priorSegments.filter((item) => !selectedKeys.has(stableJson((item as { segment?: unknown }).segment))), ...selectedSegments];
  await fs.writeFile(overlay, `${JSON.stringify({ version: 1, policyHash: queue.policyHash, segments, rollback: path.basename(rollback) }, null, 2)}\n`, { mode: 0o600 });
  for (const item of selected) item.status = "applied";
  await fs.writeFile(target, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  return { applied: selected.map((item) => item.id), overlay, rollback };
}

export async function resolveSegmentedThresholdPolicy(input: { projectRoot: string; policy: ContextRoutingPolicy; segment: ThresholdSegment }): Promise<{ policy: ContextRoutingPolicy; proposalId: string | null }> {
  const overlayPath = path.join(input.projectRoot, ".agent-workflow", "context-gateway", "approved-thresholds.json");
  await assertContextProjectPath(input.projectRoot, overlayPath);
  const raw = await readOptional(overlayPath);
  if (!raw) return { policy: input.policy, proposalId: null };
  const overlay = JSON.parse(raw) as { policyHash?: string; segments?: Array<{ proposalId: string; segment: ThresholdSegment; changes: ThresholdChange[] }> };
  if (overlay.policyHash !== hash(stableJson(input.policy))) return { policy: input.policy, proposalId: null };
  const match = overlay.segments?.find((item) => segmentMatches(item.segment, input.segment));
  if (!match) return { policy: input.policy, proposalId: null };
  const updated = { ...input.policy };
  for (const change of match.changes) updated[change.key] = change.proposed;
  return { policy: updated, proposalId: match.proposalId };
}

async function queuePath(projectRoot: string): Promise<string> { const target = path.join(projectRoot, ".agent-workflow", "context-gateway", "threshold-review.json"); await assertContextProjectPath(projectRoot, target); return target; }
async function readOptional(target: string): Promise<string | null> { try { return await fs.readFile(target, "utf8"); } catch { return null; } }
function ratio(value: number, total: number): number { return total ? round(value / total) : 0; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; } return JSON.stringify(value) ?? "null"; }
function segmentMatches(proposal: ThresholdSegment, actual: ThresholdSegment): boolean { return (Object.keys(proposal) as Array<keyof ThresholdSegment>).every((key) => proposal[key] === actual[key] || proposal[key] === "unspecified" || proposal[key] === "policy-default"); }
