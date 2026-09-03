import assert from "node:assert/strict";
import test from "node:test";
import { buildGovernanceReport, finalizeGovernanceProject } from "./index.js";

const base = {
  id: "project-1", name: "Project", rootUri: "/project", accessible: true, agentsFile: true,
  projectConfig: "valid" as const, policyProfile: "local", policyDrift: false, configDrift: false,
  provider: "openai", modelTier: null, indexedFiles: 5, runCount: 2, activeRuns: 0,
  failedRuns: 0, staleActiveRuns: 0, lastRunAt: null
};

test("healthy governance project has no remediation", () => {
  const project = finalizeGovernanceProject(base);
  assert.equal(project.health, "healthy");
  assert.deepEqual(project.recommendations, []);
  assert.equal(project.healthChecks.every((check) => check.status === "pass" || check.status === "unknown"), true);
});

test("policy drift warns while stale work is critical", () => {
  const policyDrift = finalizeGovernanceProject({ ...base, policyDrift: true });
  assert.equal(policyDrift.health, "warning");
  assert.equal(policyDrift.healthChecks.find((check) => check.id === "policy_drift")?.status, "warning");
  const stale = finalizeGovernanceProject({ ...base, staleActiveRuns: 1 });
  assert.equal(stale.health, "critical");
  assert.match(stale.recommendations.join(" "), /stale active runs/i);
  assert.match(stale.healthChecks.find((check) => check.id === "stale_active_runs")?.evidence ?? "", /1 stale active run/i);
  assert.equal(buildGovernanceReport("0.1.0", true, [stale]).counts.critical, 1);
});

test("governance checks include remediation commands when available", () => {
  const project = finalizeGovernanceProject({ ...base, agentsFile: false, indexedFiles: 0 });
  assert.equal(project.health, "warning");
  assert.match(project.healthChecks.find((check) => check.id === "agents_file")?.command ?? "", /ide-onboard/);
  assert.match(project.healthChecks.find((check) => check.id === "indexed_context")?.command ?? "", /index-project/);
});
