import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceSubjectHash } from "../packages/workflow-engine/src/source-subject.js";
import type pg from "pg";
import { acceptanceDigest, acceptancePreflight, enrollAcceptanceContract } from "../packages/storage/src/acceptance.js";
import { completeWorkflowTask, createWorkflowRun, recordRunAction, reportWorkflowDeliveryMetrics } from "../packages/storage/src/postgres.js";
import { workflowSchema } from "../packages/agent-registry/src/schemas.js";
import { reserveSupervisedRepair } from "../packages/storage/src/repair-dispatch.js";
import type { StructuredAcceptanceContract } from "../packages/model-providers/src/types.js";

/** Called only inside the disposable database harness. */
export async function verifyAcceptanceStorage(client: pg.Client): Promise<void> {
  const database = (await client.query("select current_database() as name")).rows[0].name;
  assert.match(database, /^agentflow_continuation_test_[a-f0-9]{32}$/u);
  const projectId = randomUUID(), runId = randomUUID(), taskId = randomUUID();
  const task = "Synthetic acceptance delivery";
  await client.query("insert into projects(id,name,root_uri,profile,config) values ($1,'synthetic','synthetic://acceptance','test','{}')", [projectId]);
  await client.query("insert into workflow_runs(id,project_id,status,task,autonomy,lease_epoch,lease_owner,lease_expires_at) values ($1,$2,'queued',$3,'guarded',7,'fixture-worker',now()+interval '5 minutes')", [runId, projectId, task]);
  await client.query("insert into workflow_tasks(id,run_id,stage_id,agent_id,status,idempotency_key) values ($1,$2,'verify','continuation-fixture','queued',$3)", [taskId, runId, randomUUID()]);
  const gates = ["implementation", "verification", "packaging", "supervision"] as const;
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-live-"));
  let subjectHash: string;
  let changedSubjectHash: string;
  try {
    await fs.writeFile(path.join(sourceRoot, "source.txt"), "verified source");
    subjectHash = await sourceSubjectHash(sourceRoot, ["source.txt"]);
    await fs.writeFile(path.join(sourceRoot, "source.txt"), "changed source");
    changedSubjectHash = await sourceSubjectHash(sourceRoot, ["source.txt"]);
    assert.notEqual(subjectHash, changedSubjectHash);
  } finally { await fs.rm(sourceRoot, { recursive: true, force: true }); }
  const contract: StructuredAcceptanceContract = { version: 1, contractId: randomUUID(), projectId, originRunId: runId,
    taskHash: acceptanceDigest(task), subjectHash, sourcePaths: ["source.txt"],
    deliverables: [{ id: "product", description: "Synthetic receipt-backed product", requiredGates: [...gates], status: "pending", receipts: {}, gaps: [] }] };
  await client.query("begin");
  await enrollAcceptanceContract(client, runId, contract);
  await client.query("commit");
  await client.query("update workflow_runs set status='running' where id=$1", [runId]);
  await client.query("update workflow_tasks set status='running',attempts=1,worker_id='fixture-worker',lease_generation=7,lease_expires_at=now()+interval '5 minutes' where id=$1", [taskId]);
  const request = { runId, taskId, agentId: "continuation-fixture", workerId: "fixture-worker", fencingToken: "7", summary: "Synthetic verified delivery" };
  await assert.rejects(completeWorkflowTask({ ...request, artifact: {} }), /Structured acceptance/u);
  assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "running");
  const content = { commandLine: "synthetic-check", exitCode: 0, timedOut: false, subjectHash: contract.subjectHash,
    sourcePaths: contract.sourcePaths, sourceBefore: subjectHash, sourceAfter: subjectHash };
  const uri = `db://workflow_runs/${runId}/command_output/synthetic`;
  const inserted = await client.query("insert into artifacts(run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4) returning created_at", [runId, taskId, uri, JSON.stringify(content)]);
  const proposal = structuredClone(contract);
  proposal.deliverables[0].status = "verified";
  for (const gate of gates) proposal.deliverables[0].receipts[gate] = [{ artifactUri: uri, runId, taskId, stageId: "verify", kind: "command_output",
    contentHash: acceptanceDigest(content), observedAt: inserted.rows[0].created_at.toISOString(), subjectHash: contract.subjectHash }];
  assert.equal((await acceptancePreflight(client, runId, { acceptanceContract: proposal })).accepted, true);
  // Recompute the reference digest too: rejection must be source provenance, not just tamper detection.
  for (const altered of [{ ...content, sourceAfter: changedSubjectHash }, { ...content, sourcePaths: ["other.txt"] }, { ...content, sourceBefore: null }]) {
    await client.query("update artifacts set content=$2 where uri=$1", [uri, JSON.stringify(altered)]);
    const alteredProposal = structuredClone(proposal);
    for (const gate of gates) alteredProposal.deliverables[0].receipts[gate]![0].contentHash = acceptanceDigest(altered);
    assert.equal((await acceptancePreflight(client, runId, { acceptanceContract: alteredProposal })).accepted, false);
    await assert.rejects(completeWorkflowTask({ ...request, artifact: { acceptanceContract: alteredProposal } }), /Structured acceptance/u);
    assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "running");
  }
  await client.query("update artifacts set content=$2 where uri=$1", [uri, JSON.stringify(content)]);
  await client.query("update artifacts set content=jsonb_set(content,'{exitCode}','1') where uri=$1", [uri]);
  assert.equal((await acceptancePreflight(client, runId, { acceptanceContract: proposal })).accepted, false);
  await assert.rejects(completeWorkflowTask({ ...request, artifact: { acceptanceContract: proposal } }), /Structured acceptance/u);
  await client.query("update artifacts set content=$2 where uri=$1", [uri, JSON.stringify(content)]);
  const stageOnly = structuredClone(proposal);
  stageOnly.deliverables[0].receipts.supervision = [];
  await assert.rejects(completeWorkflowTask({ ...request, artifact: { acceptanceContract: stageOnly } }), /terminal completion/u);
  assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "running");
  assert.equal((await client.query("select count(*)::int as n from artifacts where task_id=$1 and kind='stage_output'", [taskId])).rows[0].n, 0);
  assert.equal((await client.query("select count(*)::int as n from action_receipts where run_id=$1 and action_type='stage_completed'", [runId])).rows[0].n, 0);
  await completeWorkflowTask({ ...request, artifact: { acceptanceContract: proposal } });
  assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "completed");
  await assert.rejects(enrollAcceptanceContract(client, runId, contract), /unstarted/u);
  const repair = { runId, task, failure: "Synthetic missing evidence" };
  const concurrent = await Promise.all([reserveSupervisedRepair(repair), reserveSupervisedRepair(repair)]);
  assert.deepEqual(concurrent.sort(), [false, true]);
  assert.equal(await reserveSupervisedRepair(repair), false);
  await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "direct_repair_validation", target: "synthetic-fix",
    summary: "Synthetic incomplete validation", artifactKind: "direct_repair_validation", artifactContent: { validation: { failed: 0 } } });
  assert.equal(await reserveSupervisedRepair(repair), false, "Missing passed checks cannot rearm repair");
  await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "direct_repair_validation", target: "synthetic-validated-fix",
    summary: "Synthetic validated fix", artifactKind: "direct_repair_validation", artifactContent: { validation: { failed: 0, passed: 1 } } });
  assert.equal(await reserveSupervisedRepair(repair), false, "Successful-looking counters cannot rearm repair");
  await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "direct_repair_validation", target: "synthetic-governed-fix",
    summary: "Synthetic resolved verification checks", artifactKind: "direct_repair_validation", artifactContent: { acceptanceContract: proposal },
    idempotencyKey: "synthetic-governed-fix" });
  assert.equal(await reserveSupervisedRepair(repair), true);
  assert.equal(await reserveSupervisedRepair(repair), false);
  await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "direct_repair_validation", target: "synthetic-copied-report",
    summary: "Synthetic duplicate of resolved checks", artifactKind: "direct_repair_validation", artifactContent: { acceptanceContract: structuredClone(proposal) },
    idempotencyKey: "synthetic-copied-report" });
  assert.equal(await reserveSupervisedRepair(repair), false, "A new report referencing unchanged checks cannot rearm repair");
  console.log("REPAIR_BREAKER_LIVE_PASSED: one concurrent dispatch, unchanged suppression, validated-fix rearm");
  console.log("SOURCE_PROVENANCE_LIVE_PASSED: actual file hashes; changed source, changed scope and missing observation rejected despite matching receipt digests");
  const atomicInput = { projectName: "Synthetic atomic enrollment", projectRootUri: "synthetic://atomic-enrollment", projectProfile: "test", projectConfig: {},
    workflow: workflowSchema.parse({ id: "live-continuation-fixture", name: "Synthetic", description: "Synthetic", lead: "continuation-fixture", stages: [{ id: "verify", agent: "continuation-fixture", goal: "Verify", output: "evidence" }] }),
    task: "Synthetic atomic enrollment", autonomy: "guarded", policyProfile: "local", policySnapshot: {}, policySnapshotHash: "synthetic",
    acceptanceRequirements: { subjectHash, sourcePaths: ["source.txt"], deliverables: structuredClone(contract.deliverables) } };
  const atomic = await createWorkflowRun(atomicInput);
  const enrolled = (await client.query("select evaluation_metadata from workflow_runs where id=$1", [atomic.runId])).rows[0].evaluation_metadata.acceptanceContract;
  assert.equal(enrolled.originRunId, atomic.runId);
  assert.equal(enrolled.projectId, atomic.projectId);
  assert.equal((await client.query("select count(*)::int n from action_receipts where run_id=$1 and action_type='acceptance_enrolled'", [atomic.runId])).rows[0].n, 1);
  const duplicate = await createWorkflowRun(atomicInput);
  assert.equal(duplicate.runId, atomic.runId);
  assert.equal(duplicate.deduplicated, true);
  const countBefore = (await client.query("select count(*)::int n from workflow_runs")).rows[0].n;
  await assert.rejects(createWorkflowRun({ ...atomicInput, task: "Invalid synthetic enrollment", acceptanceRequirements: { ...atomicInput.acceptanceRequirements, deliverables: [] } }), /enrollment/u);
  assert.equal((await client.query("select count(*)::int n from workflow_runs")).rows[0].n, countBefore);
  const beforeDelivery = await reportWorkflowDeliveryMetrics(atomic.runId);
  assert.equal(beforeDelivery.verifiedDelivery, false);
  assert.equal(beforeDelivery.timeToVerifiedDeliveryMs, null);
  assert.equal(beforeDelivery.firstAttemptVerifiedSuccess, null);
  assert.equal(beforeDelivery.approvals.count, 0);
  assert.equal(beforeDelivery.modelLatencyMs, null);
  const afterDelivery = await reportWorkflowDeliveryMetrics(runId);
  assert.equal(afterDelivery.verifiedDelivery, true);
  assert.equal(afterDelivery.firstAttemptVerifiedSuccess, true);
  assert.ok(afterDelivery.timeToVerifiedDeliveryMs !== null && afterDelivery.timeToVerifiedDeliveryMs >= 0);
  assert.equal(afterDelivery.unnecessaryRetries, null);
  assert.equal(afterDelivery.falseBlocks, null);
  const storedMetrics = (await client.query("select content from artifacts where uri=$1 and run_id=$2 and kind='delivery_metrics'", [afterDelivery.uri, runId])).rows[0].content;
  assert.equal(storedMetrics.acceptanceEvidence, afterDelivery.acceptanceEvidence);
  assert.equal(storedMetrics.verifiedDelivery, true);
  assert.ok((await client.query("select count(*)::int n from action_receipts where run_id=$1 and action_type='delivery_metrics'", [runId])).rows[0].n > 0);
  console.log("DELIVERY_METRICS_STORAGE_LIVE_PASSED: actual run/receipt/approval/terminal artifact joins; unverified nulls and verified delivery; durable report linkage");
  console.log("ATOMIC_ENROLLMENT_LIVE_PASSED: contract and receipt created before visibility; duplicate suppressed; invalid enrollment rolls back run");
  console.log("STRUCTURED_ACCEPTANCE_LIVE_PASSED: missing and tampered receipts rejected; incomplete terminal gates roll back task, artifact and receipt; four gates and production completion passed");
}
