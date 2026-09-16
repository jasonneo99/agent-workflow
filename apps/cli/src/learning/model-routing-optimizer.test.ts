import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isFleetModelComparisonOwner, prepareRecurringModelComparison, rankComparedProviders } from "./model-routing-optimizer.js";

test("model routing optimizer promotes only comparison leaders with sufficient evidence", () => {
  const recommendations = rankComparedProviders([{ id: "review", workflowId: "review-pr", leader: "claude", latestAt: "2026-01-01", variants: [{ id: "claude", provider: "anthropic", modelTier: "reasoning", runs: 3, completed: 3, averageQuality: 0.92, averageLatencyMs: 900, fallbackRate: 0 }, { id: "openai", provider: "openai", modelTier: "reasoning", runs: 3, completed: 3, averageQuality: 0.85, averageLatencyMs: 700, fallbackRate: 0 }] }]);
  assert.deepEqual(recommendations.map((item) => [item.provider, item.status]), [["anthropic", "eligible"]]);
});

test("model routing optimizer holds thin or low-quality evidence", () => {
  const recommendations = rankComparedProviders([{ id: "fast", workflowId: "index", leader: "candidate", latestAt: "2026-01-01", variants: [{ id: "candidate", provider: "anthropic", modelTier: "fast", runs: 1, completed: 1, averageQuality: 0.6, averageLatencyMs: 100, fallbackRate: 0 }] }]);
  assert.equal(recommendations[0]?.status, "needs-evidence");
});

test("recurring comparisons rotate tiers and require the configured interval", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-model-comparison-"));
  const env = { OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic" };
  const first = await prepareRecurringModelComparison({ projectDir, enabled: true, intervalMs: 1000, now: new Date("2026-01-01T00:00:00Z"), env });
  assert.equal(first.due, true);
  assert.equal(first.tier, "fast");
  const waiting = await prepareRecurringModelComparison({ projectDir, enabled: true, intervalMs: 1000, now: new Date("2026-01-01T00:00:00.500Z"), env });
  assert.equal(waiting.due, false);
  assert.equal(waiting.tier, "standard");
  const second = await prepareRecurringModelComparison({ projectDir, enabled: true, intervalMs: 1000, now: new Date("2026-01-01T00:00:02Z"), env });
  assert.equal(second.due, true);
  assert.equal(second.tier, "standard");
});

test("fleet comparisons have exactly one control-project owner", () => {
  assert.equal(isFleetModelComparisonOwner("/fleet/control", "/fleet/control"), true);
  assert.equal(isFleetModelComparisonOwner("/fleet/project-a", "/fleet/control"), false);
});
