import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { buildContextEfficiencyReport, buildShadowObservation, contextCacheKey, contextRoutingPolicySchema, decideContextRoute, delegateContextSummary, enforceContextDecision, evaluateContextHoldouts, extractExactSlices, ProjectContextCache, sha256 } from "./index.js";

const policy = contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(new URL("../../../policies/context-routing.yaml", import.meta.url), "utf8")));

test("policy is portable YAML and remains shadow-only", () => {
  assert.equal(policy.mode, "shadow");
  assert.equal(policy.telemetry.store_file_bodies, false);
});

test("routing is token-aware and risk-aware", () => {
  assert.equal(decideContextRoute({ policy, intent: "discovery", content: "small" }).route, "direct");
  assert.equal(decideContextRoute({ policy, intent: "discovery", content: "x".repeat(12_000) }).route, "delegate");
  assert.equal(decideContextRoute({ policy, intent: "security", content: "x".repeat(12_000) }).route, "frontier");
  assert.equal(decideContextRoute({ policy, intent: "discovery", content: "x".repeat(12_000), question: "Where is authorizeUser called?" }).route, "deterministic");
});

test("an explicit risk ceiling automates medium work without relabeling it low risk", () => {
  const medium = { ...policy, automatic_risk_levels: ["low", "medium"] as Array<"low" | "medium"> };
  const decision = decideContextRoute({ policy: medium, intent: "editing", content: "x".repeat(12_000) });
  assert.equal(decision.risk, "medium");
  assert.equal(decision.route, "delegate");
  assert.equal(decideContextRoute({ policy: medium, intent: "security", content: "x".repeat(12_000) }).route, "frontier");
});

test("deterministic extraction returns cited exact slices", () => {
  const slices = extractExactSlices({
    sourcePath: "src/auth.ts",
    question: "Where is authorizeUser called?",
    content: ["import x from 'x';", "", "export function handler() {", "  return authorizeUser();", "}", "", "export const other = true;"].join("\n"),
    contextLines: 1
  });
  assert.equal(slices.length, 1);
  assert.deepEqual([slices[0].startLine, slices[0].endLine], [3, 5]);
  assert.equal(slices[0].contentHash.length, 64);
  assert.match(slices[0].excerpt, /authorizeUser/u);
});

test("cache keys invalidate on content, policy, or processor changes", () => {
  const base = { contentHash: sha256("one"), questionClass: "discovery", processorVersion: "1", model: "cheap", outputSchema: "bullets-v1", policyHash: sha256("policy-1") };
  assert.equal(contextCacheKey(base), contextCacheKey(base));
  assert.notEqual(contextCacheKey(base), contextCacheKey({ ...base, contentHash: sha256("two") }));
  assert.notEqual(contextCacheKey(base), contextCacheKey({ ...base, policyHash: sha256("policy-2") }));
});

test("shadow telemetry contains metrics and hashes but never file bodies", () => {
  const body = "secret implementation ".repeat(800);
  const observation = buildShadowObservation({ projectId: "project-1", sourcePath: "/private/src/file.ts", content: body, intent: "summarization", policy });
  assert.equal(observation.fileBodyStored, false);
  assert.equal(observation.sourcePathHash.length, 64);
  assert.equal(observation.contentHash.length, 64);
  assert.ok(observation.projectedFrontierTokensAvoided > 0);
  assert.doesNotMatch(JSON.stringify(observation), /secret implementation|\/private\/src/u);
});

test("project cache enforces isolation, expiry, and content-addressed reuse", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-context-cache-"));
  const cache = new ProjectContextCache(root, "project-a");
  const key = contextCacheKey({ contentHash: sha256("source"), questionClass: "discovery", processorVersion: "1", model: "cheap", outputSchema: "claims-v1", policyHash: sha256("policy") });
  const entry = { version: 1 as const, projectId: "project-a", key, createdAt: new Date(0).toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString(), contentHash: sha256("source"), policyHash: sha256("policy"), processorVersion: "1", model: "cheap", outputSchema: "claims-v1", summary: "safe summary", claims: [] };
  await cache.put(entry);
  assert.equal((await cache.get(key))?.summary, "safe summary");
  await assert.rejects(() => new ProjectContextCache(root, "project-b").put(entry), /different project/u);
  assert.equal(await cache.get(key, Date.now() + 20_000), null);
  assert.equal(await cache.prune(Date.now() + 20_000), 1);
});

test("project cache rejects an Agent Workflow directory symlink escaping the project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-context-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-context-outside-"));
  await fs.symlink(outside, path.join(root, ".agent-workflow"));
  const cache = new ProjectContextCache(root, "project-a");
  const key = contextCacheKey({ contentHash: sha256("source"), questionClass: "discovery", processorVersion: "1", model: "cheap", outputSchema: "claims-v1", policyHash: sha256("policy") });
  await assert.rejects(() => cache.put({ version: 1, projectId: "project-a", key, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString(), contentHash: sha256("source"), policyHash: sha256("policy"), processorVersion: "1", model: "cheap", outputSchema: "claims-v1", summary: "safe", claims: [] }), /escapes the project/u);
});

test("delegation returns structured claims and exact retrieval handles", async () => {
  const result = await delegateContextSummary({
    sourcePath: "src/service.ts",
    content: "export function loadAccount() { return database.query('account'); }",
    question: "Where does loadAccount query the database?",
    model: "mock-fast",
    summarize: async ({ deterministicSummary }) => ({ summary: `- loadAccount queries database\n- ${deterministicSummary.split("\n")[0]}` })
  });
  assert.equal(result.claims.length, 2);
  assert.match(result.claims[0].retrievalHandle, /src\/service\.ts#sha256=.*lines=/u);
  assert.equal(result.claims[0].confidence, 0.8);
});

test("efficiency reporting aggregates total-workflow savings instead of averaging read percentages", () => {
  const large = buildShadowObservation({ projectId: "p", sourcePath: "large.ts", content: "x".repeat(12_000), intent: "summarization", policy, expectedSummaryTokens: 300 });
  const direct = buildShadowObservation({ projectId: "p", sourcePath: "small.ts", content: "x".repeat(400), intent: "summarization", policy });
  const report = buildContextEfficiencyReport([large, direct]);
  assert.equal(report.observations, 2);
  assert.equal(report.eligibleReads, 1);
  assert.ok(report.projectedSavingsPercent > 80 && report.projectedSavingsPercent < 100);
});

test("holdout gates require quality, citations, savings, latency, and sample coverage", () => {
  const cases = [1, 2, 3].map((id) => ({ id: String(id), requiredTerms: ["account"], directAnswer: "account", routedAnswer: "account", citationsValid: true, directTokens: 1000, routedTokens: 300, addedLatencyMs: 500 }));
  assert.equal(evaluateContextHoldouts(cases).enforcementReady, true);
  assert.equal(evaluateContextHoldouts(cases.map((item, index) => index ? item : { ...item, citationsValid: false })).enforcementReady, false);
});

test("enforcement remains evidence-gated with exact-read and risk escape hatches", () => {
  const enforcePolicy = { ...policy, mode: "enforce" as const };
  const delegated = decideContextRoute({ policy: enforcePolicy, intent: "summarization", content: "x".repeat(12_000) });
  assert.equal(enforceContextDecision({ policy: enforcePolicy, decision: delegated, holdoutApproved: true }).action, "redirect");
  assert.equal(enforceContextDecision({ policy: enforcePolicy, decision: delegated, holdoutApproved: false }).action, "allow");
  assert.equal(enforceContextDecision({ policy: enforcePolicy, decision: delegated, holdoutApproved: true, exactReadRequested: true }).action, "allow");
  const security = decideContextRoute({ policy: enforcePolicy, intent: "security", content: "x".repeat(12_000) });
  assert.equal(enforceContextDecision({ policy: enforcePolicy, decision: security, holdoutApproved: true }).action, "promote");
});
