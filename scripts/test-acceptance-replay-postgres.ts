/** Isolated R3 regression: npm exec -- node --import tsx scripts/test-acceptance-replay-postgres.ts
 * Requires CREATEDB and the extensions in infra/init.sql. No configured database rows are changed.
 * Default expects replay completion: exact ancestry rejection is red, not product verification.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { createWorkflowRun, replayWorkflowRun, migrateStorage, claimNextWorkflowTask, startWorkflowTask, completeWorkflowTask, cancelWorkflowRun, resumeWorkflowRunFromCheckpoint, verifyRunReceiptChain } from "../packages/storage/src/postgres.js";
import { acceptanceDigest, storedAcceptanceDecision } from "../packages/storage/src/acceptance.js";
import { structuredAcceptanceDecision } from "../packages/model-providers/src/quality.js";
import { projectConfigSchema, workflowSchema } from "../packages/agent-registry/src/schemas.js";
import type { StructuredAcceptanceContract } from "../packages/model-providers/src/types.js";

const configuredUrl = databaseUrl();
const previousUrl = process.env.DATABASE_URL;
const name = `agentflow_replay_test_${randomUUID().replaceAll("-", "")}`;
assert.match(name, /^agentflow_replay_test_[a-f0-9]{32}$/u);
const disposableUrl = new URL(configuredUrl);
disposableUrl.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: configuredUrl, connectionTimeoutMillis: 5000 });
let created = false;
let client: pg.Client | undefined;
const gates = ["implementation", "verification", "packaging", "supervision"] as const;
const expected = "Structured acceptance rejected completion: Acceptance ancestry requires explicit revalidation.";
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  process.env.DATABASE_URL = disposableUrl.href;
  client = new pg.Client({ connectionString: disposableUrl.href, connectionTimeoutMillis: 5000 });
  await client.connect();
  assert.equal((await client.query("select current_database() as name")).rows[0].name, name);
  await client.query(await readFile(new URL("../infra/init.sql", import.meta.url), "utf8"));
  await migrateStorage();
  for (const id of ["r3-fixture", "workflow-orchestrator"]) {
    await client.query("insert into agents(id,display_name,category,source_path,definition) values ($1,'Synthetic','test','synthetic','{}')", [id]);
  }
  const workflow = workflowSchema.parse({ id: "r3-replay-fixture", name: "Synthetic replay", description: "Isolated acceptance identity", lead: "r3-fixture", stages: [{ id: "verify", agent: "r3-fixture", goal: "Synthetic receipt verification", output: "evidence" }] });
  await client.query("insert into workflows(id,name,source_path,definition) values ($1,$2,'synthetic',$3)", [workflow.id, workflow.name, JSON.stringify(workflow)]);
  const config = projectConfigSchema.parse({ project: { name: "Synthetic R3", autonomy: 2 } });
  const root = `synthetic://r3/${randomUUID()}`;
  const subjectHash = acceptanceDigest("unchanged synthetic source");
  const source = await createWorkflowRun({ projectName: "Synthetic R3", projectRootUri: root, projectProfile: "test", projectConfig: config, workflow, task: "Synthetic R3 acceptance replay", autonomy: "2", policyProfile: "local", policySnapshot: config, policySnapshotHash: acceptanceDigest(config), acceptanceRequirements: { subjectHash, sourcePaths: ["source.txt"], deliverables: [{ id: "product", description: "Synthetic frozen deliverable", requiredGates: [...gates], status: "pending", receipts: {}, gaps: [] }] } });
  const frozen = async (runId: string): Promise<StructuredAcceptanceContract> => {
    const row = (await client!.query("select evaluation_metadata from workflow_runs where id=$1", [runId])).rows[0];
    assert.ok(row.evaluation_metadata.acceptanceContract, "Structured requirements must not disappear");
    return row.evaluation_metadata.acceptanceContract;
  };
  const exercise = async (runId: string, replay: boolean, subjectHash = acceptanceDigest("unchanged synthetic source")) => {
    const claimed = await claimNextWorkflowTask({ projectRootUri: root, workerId: "r3-worker" });
    assert.ok(claimed);
    assert.equal(claimed.runId, runId);
    await startWorkflowTask({ taskId: claimed.taskId, runId, workerId: "r3-worker", fencingToken: claimed.fencingToken });
    const contract = await frozen(runId);
    const content = { commandLine: "synthetic-check", exitCode: 0, timedOut: false, subjectHash, sourcePaths: ["source.txt"], sourceBefore: subjectHash, sourceAfter: subjectHash };
    const uri = `db://workflow_runs/${runId}/command_output/fresh`;
    const inserted = await client!.query("insert into artifacts(run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4) returning created_at", [runId, claimed.taskId, uri, JSON.stringify(content)]);
    const reference = { artifactUri: uri, runId, taskId: claimed.taskId, stageId: "verify", kind: "command_output" as const, contentHash: acceptanceDigest(content), observedAt: inserted.rows[0].created_at.toISOString(), subjectHash };
    const proposal = structuredClone(contract);
    proposal.deliverables[0].status = "verified";
    for (const gate of gates) proposal.deliverables[0].receipts[gate] = [reference];
    // In-memory identity control only; never rewrites storage or provider requirements.
    const identityControl = { ...proposal, originRunId: runId };
    for (const gate of gates) {
      assert.equal((await structuredAcceptanceDecision(identityControl, gate, async () => ({ ...reference, projectId: source.projectId, passed: true }))).reason, null);
    }
    if (replay) {
      assert.equal(contract.originRunId, runId);
      for (const control of ["hash", "source", "foreign-run", "project", "requirements"] as const) {
        const invalid = structuredClone(proposal);
        if (control === "project") invalid.projectId = randomUUID();
        else if (control === "requirements") invalid.deliverables[0].description = "Unauthorized rewrite";
        else for (const gate of gates) {
          const ref = invalid.deliverables[0].receipts[gate]![0];
          if (control === "hash") ref.contentHash = acceptanceDigest("tampered");
          if (control === "source") ref.subjectHash = acceptanceDigest("stale");
          if (control === "foreign-run") {
            ref.runId = source.runId;
            ref.artifactUri = `db://workflow_runs/${source.runId}/command_output/fresh`;
          }
        }
        await assert.rejects(completeWorkflowTask({ taskId: claimed.taskId, runId, agentId: claimed.agentId,
          workerId: "r3-worker", fencingToken: claimed.fencingToken, summary: "Invalid control",
          artifact: { acceptanceContract: invalid } }), /Structured acceptance rejected/);
        assert.equal((await client!.query("select status from workflow_tasks where id=$1", [claimed.taskId])).rows[0].status, "running");
      }
      console.log("R3_NEGATIVE_CONTROLS_PASSED");
    }
    try {
      await completeWorkflowTask({ taskId: claimed.taskId, runId, agentId: claimed.agentId, workerId: "r3-worker", fencingToken: claimed.fencingToken, summary: "Synthetic receipt-backed completion", artifact: { acceptanceContract: proposal } });
    } catch (error) {
      const actual = error instanceof Error ? error.message : String(error);
      if (replay && actual === expected) {
        assert.equal((await client!.query("select status from workflow_tasks where id=$1", [claimed.taskId])).rows[0].status, "running");
        assert.equal((await client!.query("select count(*)::int n from artifacts where run_id=$1 and kind='stage_output'", [runId])).rows[0].n, 0);
        console.log(JSON.stringify({ marker: "R3_REPLAY_RED", expected: "fresh replay completes", actual, sourceRunId: source.runId, replayRunId: runId, inheritedOriginRunId: contract.originRunId, receiptRunId: reference.runId, rollbackConfirmed: true }));
      }
      throw error;
    }
    assert.equal((await client!.query("select status from workflow_runs where id=$1", [runId])).rows[0].status, "completed");
  };
  await exercise(source.runId, false);
  const sourceContract = await frozen(source.runId);
  console.log("R3_SOURCE_CONTROL_COMPLETED");
  const replacement = await replayWorkflowRun({ sourceRunId: source.runId, actor: "r3-fixture", reason: "Synthetic authorized fresh replay", preserveCompletedCheckpoints: false });
  assert.ok(replacement);
  assert.notEqual(replacement.runId, source.runId);
  assert.equal(replacement.projectId, source.projectId);
  assert.equal(replacement.queuedTasks, 1);
  assert.deepEqual(await frozen(source.runId), sourceContract);
  assert.equal((await client.query("select status from workflow_runs where id=$1", [source.runId])).rows[0].status, "completed");
  await exercise(replacement.runId, true);
  console.log("R3_REPLAY_GREEN: fresh replay completed with fresh receipts");
  await assert.rejects(replayWorkflowRun({ sourceRunId: replacement.runId, actor: "r3-fixture", reason: "Reject contract removal",
    evaluationMetadataPatch: { acceptanceContract: null } }), /runtime-owned/);
  const checkpoint = await replayWorkflowRun({ sourceRunId: replacement.runId, actor: "r3-fixture", reason: "Checkpoint must revalidate",
    preserveCompletedCheckpoints: true, skipStageIds: ["verify"] });
  assert.ok(checkpoint);
  assert.equal(checkpoint.completedTasks, 0);
  assert.equal(checkpoint.skippedTasks, 0);
  assert.equal(checkpoint.queuedTasks, 1);
  assert.equal((await frozen(checkpoint.runId)).originRunId, checkpoint.runId);
  await exercise(checkpoint.runId, true);
  console.log("R3_CHECKPOINT_FRESH_REVALIDATION_PASSED");
  const legacy = await createWorkflowRun({ projectName: "Synthetic R3", projectRootUri: root, projectProfile: "test", projectConfig: config, workflow, task: "Synthetic legacy acceptance enrollment", autonomy: "2", policyProfile: "local", policySnapshot: config, policySnapshotHash: acceptanceDigest(config) });
  // Remove only synthetic queued work from dispatch, without altering its history.
  await client.query("update workflow_tasks set status='cancelled' where run_id=$1", [legacy.runId]);
  const requirements = { subjectHash, sourcePaths: ["source.txt"], deliverables: [{ id: "product", description: "Synthetic frozen deliverable", requiredGates: [...gates], status: "pending" as const, receipts: {}, gaps: [] }] };
  const enrolled = await replayWorkflowRun({ sourceRunId: legacy.runId, actor: "r3-fixture", reason: "Explicit legacy enrollment", acceptanceRequirements: requirements, preserveCompletedCheckpoints: true, skipStageIds: ["verify"] });
  assert.ok(enrolled);
  assert.equal(enrolled.queuedTasks, 1);
  assert.equal(enrolled.completedTasks, 0);
  assert.equal(enrolled.skippedTasks, 0);
  assert.equal((await frozen(enrolled.runId)).originRunId, enrolled.runId);
  assert.equal((await client.query("select evaluation_metadata->'acceptanceContract' as contract from workflow_runs where id=$1", [legacy.runId])).rows[0].contract, null);
  await exercise(enrolled.runId, true);
  await assert.rejects(replayWorkflowRun({ sourceRunId: legacy.runId, actor: "r3-fixture", reason: "Reject silently ignored enrollment", acceptanceRequirements: requirements }), /cannot reuse an existing replacement/);
  await assert.rejects(replayWorkflowRun({ sourceRunId: enrolled.runId, actor: "r3-fixture", reason: "Reject frozen replacement", acceptanceRequirements: requirements }), /already has frozen acceptance/);
  const invalidLegacy = await createWorkflowRun({ projectName: "Synthetic R3", projectRootUri: root, projectProfile: "test", projectConfig: config, workflow, task: "Synthetic invalid legacy enrollment", autonomy: "2", policyProfile: "local", policySnapshot: config, policySnapshotHash: acceptanceDigest(config) });
  const runCount = Number((await client.query("select count(*) as n from workflow_runs where project_id=$1", [source.projectId])).rows[0].n);
  await assert.rejects(replayWorkflowRun({ sourceRunId: invalidLegacy.runId, actor: "r3-fixture", reason: "Reject preverified enrollment", acceptanceRequirements: {
    ...requirements, deliverables: requirements.deliverables.map((item) => ({ ...item, status: "verified" as const }))
  } }), /complete pending requirements/);
  assert.equal(Number((await client.query("select count(*) as n from workflow_runs where project_id=$1", [source.projectId])).rows[0].n), runCount, "Invalid enrollment must roll back the replacement run");
  console.log("R3_LEGACY_ATOMIC_ENROLLMENT_PASSED");
  await client.query("update workflow_tasks set status='cancelled' where run_id=$1", [invalidLegacy.runId]);
  const previousContract = await frozen(enrolled.runId);
  const changedHash = acceptanceDigest("validated changed synthetic source");
  const revalidated = await replayWorkflowRun({ sourceRunId: enrolled.runId, actor: "r3-fixture", reason: "Explicit repaired-source revalidation", revalidatedSubjectHash: changedHash, preserveCompletedCheckpoints: true });
  assert.ok(revalidated);
  assert.equal(revalidated.queuedTasks, 1);
  assert.equal(revalidated.completedTasks, 0);
  assert.deepEqual(await frozen(enrolled.runId), previousContract, "Historical contract must remain immutable");
  const rebound = await frozen(revalidated.runId);
  assert.equal(rebound.subjectHash, changedHash);
  assert.deepEqual(rebound.sourcePaths, previousContract.sourcePaths);
  assert.deepEqual(rebound.deliverables.map(({ id, description, requiredGates }) => ({ id, description, requiredGates })), previousContract.deliverables.map(({ id, description, requiredGates }) => ({ id, description, requiredGates })));
  assert.ok(rebound.deliverables.every((item) => item.status === "pending" && Object.keys(item.receipts).length === 0));
  await exercise(revalidated.runId, true, changedHash);
  await assert.rejects(replayWorkflowRun({ sourceRunId: enrolled.runId, actor: "r3-fixture", reason: "Reject revalidation reuse", revalidatedSubjectHash: changedHash }), /cannot reuse/);
  await assert.rejects(replayWorkflowRun({ sourceRunId: revalidated.runId, actor: "r3-fixture", reason: "Reject invalid hash", revalidatedSubjectHash: "invalid" }), /SHA-256/);
  console.log("R3_EXPLICIT_SOURCE_REVALIDATION_PASSED");
  const recoveryWorkflow = workflowSchema.parse({ ...workflow, id: "recovery-fixture", stages: [
    workflow.stages[0], { id: "package", agent: "r3-fixture", goal: "Fresh acceptance", output: "evidence", depends_on: ["verify"] }
  ] });
  await client.query("insert into workflows(id,name,source_path,definition) values ($1,$2,'synthetic',$3)", [recoveryWorkflow.id, recoveryWorkflow.name, JSON.stringify(recoveryWorkflow)]);
  const recoveryRoot = `synthetic://recovery/${randomUUID()}`;
  const recoverySource = await createWorkflowRun({ projectName: "Synthetic recovery", projectRootUri: recoveryRoot,
    projectProfile: "test", projectConfig: config, workflow: recoveryWorkflow, task: "Synthetic checkpoint recovery",
    autonomy: "2", policyProfile: "local", policySnapshot: config, policySnapshotHash: acceptanceDigest(config), acceptanceRequirements: requirements });
  const finishRecoveryStage = async (runId: string, stageId: string, historical?: StructuredAcceptanceContract) => {
    const claimed = await claimNextWorkflowTask({ projectRootUri: recoveryRoot, workerId: "recovery-worker" });
    assert.ok(claimed);
    assert.equal(claimed.runId, runId);
    assert.equal(claimed.stageId, stageId);
    await startWorkflowTask({ taskId: claimed.taskId, runId, workerId: "recovery-worker", fencingToken: claimed.fencingToken });
    const contract = await frozen(runId);
    const request = { taskId: claimed.taskId, runId, agentId: claimed.agentId, workerId: "recovery-worker", fencingToken: claimed.fencingToken, summary: "Synthetic fresh evidence" };
    if (historical) {
      await assert.rejects(completeWorkflowTask({ ...request, artifact: { acceptanceContract: historical } }), /Structured acceptance rejected/);
      const forged = { ...historical, contractId: contract.contractId, originRunId: runId, subjectHash: contract.subjectHash };
      await assert.rejects(completeWorkflowTask({ ...request, artifact: { acceptanceContract: forged } }), /Structured acceptance rejected/);
    }
    const content = { commandLine: "synthetic-recovery-check", exitCode: 0, timedOut: false, subjectHash: contract.subjectHash,
      sourcePaths: contract.sourcePaths, sourceBefore: contract.subjectHash, sourceAfter: contract.subjectHash };
    const uri = `db://workflow_tasks/${claimed.taskId}/command_output/fresh`;
    const inserted = await client!.query("insert into artifacts(run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4) returning created_at", [runId, claimed.taskId, uri, JSON.stringify(content)]);
    const proposal = structuredClone(contract);
    proposal.deliverables[0].status = "verified";
    for (const gate of gates) proposal.deliverables[0].receipts[gate] = [{ artifactUri: uri, runId, taskId: claimed.taskId, stageId,
      kind: "command_output", contentHash: acceptanceDigest(content), observedAt: inserted.rows[0].created_at.toISOString(), subjectHash: contract.subjectHash }];
    if (historical) {
      const incomplete = structuredClone(proposal);
      incomplete.deliverables[0].receipts.implementation = [];
      await assert.rejects(completeWorkflowTask({ ...request, artifact: { acceptanceContract: incomplete } }), /terminal completion/);
    }
    await completeWorkflowTask({ ...request, artifact: { acceptanceContract: proposal } });
    return { proposal, taskId: claimed.taskId };
  };
  const historical = await finishRecoveryStage(recoverySource.runId, "verify");
  // A later same-command failure invalidates current acceptance, not the exact
  // previously completed checkpoint. Recovery must still demand fresh evidence.
  await client.query("insert into artifacts(run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4)",
    [recoverySource.runId, historical.taskId, `db://synthetic/${randomUUID()}`, JSON.stringify({ commandLine: "synthetic-recovery-check", exitCode: 1, timedOut: false })]);
  assert.notEqual((await storedAcceptanceDecision(client, recoverySource.runId, "verification", { acceptanceContract: historical.proposal })).reason, null);
  await cancelWorkflowRun(recoverySource.runId);
  const historicalOutput = (await client.query("select content from artifacts where task_id=$1 and kind='stage_output'", [historical.taskId])).rows[0].content;
  await client.query("update artifacts set content='{}' where task_id=$1 and kind='stage_output'", [historical.taskId]);
  await assert.rejects(resumeWorkflowRunFromCheckpoint({ runId: recoverySource.runId, actor: "r3-fixture", reason: "Tampered checkpoint control", includeFailed: true }), /completion receipt/);
  assert.equal((await client.query("select replacement_run_id from workflow_runs where id=$1", [recoverySource.runId])).rows[0].replacement_run_id, null);
  await client.query("update artifacts set content=$2 where task_id=$1 and kind='stage_output'", [historical.taskId, JSON.stringify(historicalOutput)]);
  const recovered = await resumeWorkflowRunFromCheckpoint({ runId: recoverySource.runId, actor: "r3-fixture",
    reason: "Synthetic validated recovery", includeFailed: true, revalidatedSubjectHash: changedHash });
  assert.ok(recovered.replacementRunId);
  assert.equal(recovered.completedTasks, 1);
  assert.equal(recovered.requeuedTasks, 1);
  const recoveredId = recovered.replacementRunId;
  const preserved = (await client.query("select content from artifacts where run_id=$1 and kind='stage_output'", [recoveredId])).rows[0].content;
  assert.equal(preserved.checkpointPreservedFromRunId, recoverySource.runId);
  assert.equal(preserved.checkpointEvidence.mode, "historical-only");
  assert.equal(preserved.acceptanceContract.originRunId, recoverySource.runId);
  assert.equal((await frozen(recoveredId)).subjectHash, changedHash);
  assert.ok((await frozen(recoveredId)).deliverables.every(item => item.status === "pending" && !Object.keys(item.receipts).length));
  await cancelWorkflowRun(recoveredId);
  // A second failure must not discard inherited checkpoints or trust their labels.
  await client.query("update artifacts set content=jsonb_set(content,'{checkpointEvidence,sourceArtifactHash}','\"tampered\"') where run_id=$1 and kind='stage_output'", [recoveredId]);
  await assert.rejects(resumeWorkflowRunFromCheckpoint({ runId: recoveredId, actor: "r3-fixture", reason: "Inherited tamper control", includeFailed: true }), /ancestry attestation/);
  await client.query("update artifacts set content=$2 where run_id=$1 and kind='stage_output'", [recoveredId, JSON.stringify(preserved)]);
  const recoveredAgain = await resumeWorkflowRunFromCheckpoint({ runId: recoveredId, actor: "r3-fixture", reason: "Validated repeated recovery", includeFailed: true });
  assert.ok(recoveredAgain.replacementRunId);
  assert.equal(recoveredAgain.completedTasks, 1);
  assert.equal(recoveredAgain.requeuedTasks, 1);
  await finishRecoveryStage(recoveredAgain.replacementRunId, "package", historical.proposal);
  assert.equal((await client.query("select status from workflow_runs where id=$1", [recoveredAgain.replacementRunId])).rows[0].status, "completed");
  assert.equal((await verifyRunReceiptChain(recoveredAgain.replacementRunId)).valid, true);
  assert.equal((await verifyRunReceiptChain(recoveredId)).valid, true);
  assert.equal((await verifyRunReceiptChain(recoverySource.runId)).valid, true);
  assert.deepEqual((await client.query("select content from artifacts where task_id=$1 and kind='stage_output'", [historical.taskId])).rows[0].content, historicalOutput);
  console.log("R3_RECOVERY_CHECKPOINT_PRESERVED_FRESH_ACCEPTANCE_AND_TAMPER_CONTROLS_PASSED");
  console.log("R3_REPEATED_RECOVERY_VALIDATED_ANCESTRY_PASSED");
  console.log("R3_HISTORICAL_COMPLETION_CUTOFF_CURRENT_SUPERSESSION_PASSED");
} finally {
  await client?.end();
  try {
    if (created) {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      assert.equal((await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount, 0);
      console.log(JSON.stringify({ marker: "R3_DISPOSABLE_DATABASE_REMOVED", database: name }));
    }
  } finally {
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
}
