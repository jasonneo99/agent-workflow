import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("exact-run workers do not recover unrelated expired leases", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const worker = source.slice(source.indexOf("export async function runWorkerOnce"), source.indexOf("result.claimed += 1"));
  assert.match(worker, /if \(options\?\.runId === undefined && options\?\.recoverExpiredLeases !== false\)/u);
  assert.match(worker, /claimNextWorkflowTask\(\{\s*\.\.\.options,/u);
  assert.match(worker, /runWorkerOnceConcurrently\(safeLimit, \{ \.\.\.options,/u);
});

test("exact-run claims bind UUID before selection without dropping existing guards", () => {
  const source = readFileSync(new URL("../../storage/src/postgres.ts", import.meta.url), "utf8");
  const claim = source.slice(source.indexOf("export async function claimNextWorkflowTask"), source.indexOf("export async function startWorkflowTask"));
  assert.match(claim, /runId\?: string/u);
  assert.match(claim, /input\?\.runId === undefined \? null : input\.runId\.trim\(\)/u);
  assert.match(claim, /throw new Error\("Exact worker runId must be a UUID"\)/u);
  assert.match(claim, /and \(\$9::uuid is null or wr\.id = \$9::uuid\)/u);
  assert.match(claim, /workerPlatform\]\.concat\(\[runId\]\)/u);
  for (const guard of ["p.root_uri = $3", "allowed_platforms", "cardinality($4::text[])", "project_active.status in ('leased', 'running')", "prior.status <> 'completed'", "for update of wt skip locked"]) {
    assert.ok(claim.includes(guard), `Missing existing claim guard: ${guard}`);
  }
});

test("coordinator children require exact claim, matching worker and live assignment intent at effects", () => {
  const source = readFileSync(new URL("../../storage/src/postgres.ts", import.meta.url), "utf8");
  const predicate = source.slice(source.indexOf("async function coordinatorWorkerFencePredicate"), source.indexOf("export async function claimNextWorkflowTask"));
  assert.match(predicate, /to_regclass\('queue_coordinator_assignments'\)/u);
  assert.match(predicate, /if \(!available\) return "not .*queueCoordinatorClaimId/u);
  for (const guard of ["intent.project_id=assignment.project_id", "intent.owner=assignment.owner", "intent.fencing_token::text=assignment.intent_fence", "intent.expires_at>now()", "assignment.child_run_id=wr.id", "assignment.project_id=wr.project_id", "assignment.fence::text=wr.evaluation_metadata->>'queueCoordinatorFence'", "assignment.state='running'", "assignment.owner || ':' || assignment.fence::text"]) {
    assert.ok(predicate.includes(guard), `Missing coordinator fence: ${guard}`);
  }
  const claim = source.slice(source.indexOf("export async function claimNextWorkflowTask"), source.indexOf("export async function startWorkflowTask"));
  assert.ok(claim.includes("or $9::uuid=wr.id)"));
  assert.ok(claim.includes('coordinatorWorkerFencePredicate(client, "$1")'));
  assert.ok(claim.includes("and ${coordinatorFence}"));
  const effect = source.slice(source.indexOf("async function assertActiveTaskFence"), source.indexOf("export async function renewWorkflowTaskLease"));
  assert.ok(effect.includes('coordinatorWorkerFencePredicate(client, "$2")'));
  assert.ok(effect.includes("and ${coordinatorFence}"));
});

test("strict provider authorization covers every execution and disables environment chains", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.ok(source.includes("strictProviderIds === undefined ? configuredFallbackPolicy : { ...configuredFallbackPolicy, chains: {} }"));
  assert.ok(source.includes("strictProviderIds !== undefined && !strictProviderIds.has(providerId)"));
  assert.ok(source.includes("strictProviderIds.has(configuredQualityFallbackProviderId)"));
  const calls = [...source.matchAll(/providerFactory: ([^\n}]+)/gu)];
  assert.equal(calls.length, 8);
  assert.ok(calls.every(call => call[1].trim() === "guardedProviderFactory"));
  assert.ok(source.includes("return providerWithInfluence(providerFromEnv(providerId));"));
});
