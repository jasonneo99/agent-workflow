#!/usr/bin/env node
import "dotenv/config";
import { acquireWorkIntent, listWorkIntents, releaseWorkIntent, renewWorkIntent, withClient } from "../../../packages/storage/src/postgres.js";
import { evaluateReliabilitySlos, reliabilityFailureScenarios, type ReliabilitySample } from "../../../packages/reliability-control/src/index.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined;
}
function required(name: string): string { const value = arg(name); if (!value) throw new Error(`--${name} is required`); return value; }

async function reliabilitySample(): Promise<ReliabilitySample> {
  return withClient(async (client) => {
    const result = await client.query<{ totalMutations: number; receiptedMutations: number; duplicateSideEffects: number; stuckRuns: number; invalidTerminalRuns: number }>(`
      select
        (select count(*)::int from side_effect_receipts) as "totalMutations",
        (select count(*)::int from side_effect_receipts where receipt <> '{}'::jsonb) as "receiptedMutations",
        0::int as "duplicateSideEffects",
        (select count(*)::int from workflow_tasks where status in ('leased','running') and lease_expires_at<now()) as "stuckRuns",
        (select count(*)::int from workflow_runs wr where wr.status='completed' and exists(select 1 from workflow_tasks wt where wt.run_id=wr.id and wt.status not in ('completed','cancelled'))) as "invalidTerminalRuns"
    `);
    return { ...result.rows[0], recoveryDurationsMs: [], fleetFalseCriticals: 0, rollbackDurationsMs: [] };
  });
}

async function main(): Promise<void> {
  const [command = "report", action] = process.argv.slice(2);
  if (command === "intent") {
    if (action === "acquire") console.log(JSON.stringify(await acquireWorkIntent({ projectId: required("project"), owner: required("owner"), objective: required("objective"), fileScopes: (arg("files") ?? "").split(",").filter(Boolean), ttlSeconds: Number(arg("ttl") ?? 900) }), null, 2));
    else if (action === "renew") console.log(JSON.stringify({ renewed: await renewWorkIntent({ projectId: required("project"), owner: required("owner"), fencingToken: required("token"), ttlSeconds: Number(arg("ttl") ?? 900) }) }, null, 2));
    else if (action === "release") console.log(JSON.stringify({ released: await releaseWorkIntent({ projectId: required("project"), owner: required("owner"), fencingToken: required("token") }) }, null, 2));
    else console.log(JSON.stringify(await listWorkIntents(arg("project")), null, 2));
    return;
  }
  if (command === "chaos") {
    console.log(JSON.stringify({ kind: "agentflow_reliability_failure_matrix", mode: "contract-simulation", scenarios: reliabilityFailureScenarios.map((id) => ({ id, coverage: "contract", executionRequired: true })) }, null, 2)); return;
  }
  const sample = await reliabilitySample();
  console.log(JSON.stringify({ kind: "agentflow_reliability_slo_report", generatedAt: new Date().toISOString(), sample, ...evaluateReliabilitySlos(sample) }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
