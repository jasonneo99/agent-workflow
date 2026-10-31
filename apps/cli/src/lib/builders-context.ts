import type { CliContext } from "./context.js";
import { loadContextRoutingPolicy } from "./builders-shared.js";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { readLatestCalibration } from "../../../../packages/context-calibration/src/index.js";
import { buildContextEfficiencyReport, readContextCacheHealth, readShadowObservations } from "../../../../packages/context-gateway/src/index.js";
import { type ContextHost, hostHookDefinition } from "../../../../packages/context-host-adapters/src/index.js";
import { listCodegenPlans } from "../../../../packages/governed-codegen/src/index.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function hasApprovedContextHoldout(projectDir: string): Promise<boolean> {
  try {
    const evidence = JSON.parse(await fs.readFile(path.join(projectDir, ".agent-workflow", "context-gateway", "holdout", "latest.json"), "utf8")) as { enforcementReady?: boolean; caseBodiesStored?: boolean };
    return evidence.enforcementReady === true && evidence.caseBodiesStored === false;
  } catch { return false; }
}

export async function loadContextOperatorReport(ctx: CliContext, projectDir: string) {
  const project = await loadProjectConfig(projectDir);
  // Read-only status: never register or require shared storage.
  let projectId = "local:" + (await import("node:crypto")).createHash("sha256").update(projectDir).digest("hex");
  let storageStatus = "unavailable";
  try {
    const { withClient } = await import("../../../../packages/storage/src/client.js");
    const found = await withClient(async (client) => (await client.query("select id::text from projects where root_uri=$1", [projectDir])).rows[0]);
    storageStatus = found ? "available" : "unregistered";
    if (found) projectId = found.id;
  } catch { /* Local status remains available; no remote evidence is implied. */ }
  const [observations, cache, plans, calibration, policy, holdoutApproved] = await Promise.all([
    readShadowObservations({ projectRoot: projectDir, projectId }),
    readContextCacheHealth({ projectRoot: projectDir, projectId }),
    listCodegenPlans(projectDir),
    readLatestCalibration(projectDir),
    loadContextRoutingPolicy(ctx, projectDir),
    hasApprovedContextHoldout(projectDir)
  ]);
  const installed = async (host: ContextHost) => {
    const definition = hostHookDefinition(host);
    try { return (await fs.readFile(path.join(projectDir, definition.relativePath), "utf8")).includes("agentflow context-hook"); } catch { return false; }
  };
  const [claude, cursor, codex] = await Promise.all([installed("claude"), installed("cursor"), installed("codex")]);
  const planSummaries = plans.map(({ id, createdAt, target, status, provider, receipt }) => ({ id, createdAt, target, status, provider, receipt }));
  return {
    version: 1, storageStatus, evidenceScope: storageStatus === "available" ? "registered-project" : "local-identity-only", projectName: project.project.name, projectId, policyMode: policy.mode, holdoutApproved,
    efficiency: buildContextEfficiencyReport(observations), cache, hosts: { claude, cursor, codex }, calibration,
    codegen: { total: plans.length, awaitingReview: plans.filter((item) => item.status === "awaiting-review").length, plans: planSummaries }
  };
}
