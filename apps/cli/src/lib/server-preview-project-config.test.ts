import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateRoleGate } from "./builders-shared.js";
import { resolveServerPreviewProjectConfig } from "./builders-server.js";

function summary(rootUri: string, config: Record<string, unknown> = {}, name = "example-project") {
  return {
    id: "6d2a0851-d07d-4ce0-80f5-5878832a19f9", name, rootUri, profile: "custom", config,
    updatedAt: "", indexedFiles: 0, indexedTokens: 0, lastIndexedAt: null, memoryItems: 0,
    runCount: 0, completedRuns: 0, failedRuns: 0, queuedRuns: 0, runningRuns: 0,
    lastRunAt: null, lastRunId: null, lastWorkflowId: null, lastRunStatus: null
  };
}

async function withTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aw-preview-config-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a missing root never becomes a schema error: registry config, checkout unavailable", async () => {
  const stored = { project: { name: "example-project", default_workflows: ["build-feature"] }, team: { enforcement: "preview", roles: {} } };
  const result = await resolveServerPreviewProjectConfig(summary("/nonexistent/agentflow-fixture/example-missing", stored));
  assert.equal(result.checkoutAvailable, false);
  assert.equal(result.source, "registry");
  assert.deepEqual(result.config?.project.default_workflows, ["build-feature"]);
  assert.equal(evaluateRoleGate(result.config!, "operator", "can_request_approvals").allowed, true);
});

test("an empty stored config falls back to a minimal valid config", async () => {
  const result = await resolveServerPreviewProjectConfig(summary("/nonexistent/agentflow-fixture/none", {}, "Example Project"));
  assert.equal(result.source, "minimal");
  assert.equal(result.config?.project.name, "Example Project");
  assert.equal(result.config?.team.enforcement, "preview");
});

test("a checkout's own project.yaml wins, and an invalid one stays a failure", async () => {
  await withTemp(async (dir) => {
    await mkdir(path.join(dir, ".agent-workflow"), { recursive: true });
    await writeFile(path.join(dir, ".agent-workflow", "project.yaml"),
      "project:\n  name: example-config\n  default_workflows: [review-pr]\n");
    const good = await resolveServerPreviewProjectConfig(summary(dir, { project: { name: "stale" } }, "example-config"));
    assert.equal(good.checkoutAvailable, true);
    assert.equal(good.source, "checkout");
    assert.equal(good.config?.project.name, "example-config");

    await writeFile(path.join(dir, ".agent-workflow", "project.yaml"), "project: [not, an, object]\n");
    const bad = await resolveServerPreviewProjectConfig(summary(dir, { project: { name: "stale" } }, "example-config"));
    assert.equal(bad.source, "invalid-checkout");
    assert.equal(bad.config, null);
  });
});

test("a checkout without project.yaml uses the registry config", async () => {
  await withTemp(async (dir) => {
    const result = await resolveServerPreviewProjectConfig(summary(dir, { project: { name: "example-assistant" } }, "example-assistant"));
    assert.equal(result.checkoutAvailable, true);
    assert.equal(result.source, "registry");
  });
});
