import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { proposeContextThresholds, runRepositoryCalibration } from "./index.js";

test("threshold proposals stay review-required and preserve the direct boundary", () => {
  const proposal = proposeContextThresholds({ version: 1, corpus: "x", corpusHash: "x", cases: 6, qualityPassRate: 1, citationPassRate: 1, tokenSavingsPercent: 20, p95AddedLatencyMs: 10, routes: {}, risks: {}, regression: { baselineFound: false, qualityDelta: 0, citationDelta: 0, savingsDelta: 0, latencyDeltaMs: 0, passed: true }, enforcementReady: false }, { version: 1, mode: "shadow", direct_read_max_tokens: 1000, delegation_min_tokens: 2000, max_exact_slice_tokens: 500, summary_cache_ttl_seconds: 10, low_risk_intents: ["discovery"], frontier_required_intents: ["security"], deterministic_extractors: ["text_match"], telemetry: { store_file_bodies: false, hash_source_paths: true, record_project_id: true, record_content_hash: true } });
  assert.equal(proposal.status, "review-required");
  assert.equal(proposal.changes[0]?.proposed, 1600);
});

test("repository calibration hashes evidence and detects baseline regressions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-calibration-"));
  try {
    for (let index = 0; index < 6; index += 1) await fs.writeFile(path.join(root, `case-${index}.txt`), `needle${index}\n${"context ".repeat(100)}`);
    const corpus = { version: 1 as const, name: "fixture", cases: Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, file: `case-${index}.txt`, question: `Where is needle${index}?`, requiredTerms: [`needle${index}`], intent: "discovery" as const })) };
    const policy = { version: 1 as const, mode: "shadow" as const, direct_read_max_tokens: 1, delegation_min_tokens: 2, max_exact_slice_tokens: 100, summary_cache_ttl_seconds: 10, low_risk_intents: ["discovery" as const], frontier_required_intents: ["security" as const], deterministic_extractors: ["text_match" as const], telemetry: { store_file_bodies: false as const, hash_source_paths: true, record_project_id: true, record_content_hash: true } };
    const first = await runRepositoryCalibration({ projectRoot: root, corpus, corpusRaw: JSON.stringify(corpus), policy });
    assert.equal(first.report.qualityPassRate, 1);
    assert.equal(first.cases[0]?.fileHash.length, 64);
    const second = await runRepositoryCalibration({ projectRoot: root, corpus, corpusRaw: JSON.stringify(corpus), policy, baseline: { ...first.report, tokenSavingsPercent: 100 } });
    assert.equal(second.report.regression.passed, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
