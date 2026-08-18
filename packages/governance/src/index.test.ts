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
});

test("policy drift warns while stale work is critical", () => {
  assert.equal(finalizeGovernanceProject({ ...base, policyDrift: true }).health, "warning");
  const stale = finalizeGovernanceProject({ ...base, staleActiveRuns: 1 });
  assert.equal(stale.health, "critical");
  assert.match(stale.recommendations.join(" "), /stale active runs/i);
  assert.equal(buildGovernanceReport("0.1.0", true, [stale]).counts.critical, 1);
});
