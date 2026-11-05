import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as api from "./postgres.js";
import { withClient } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { repairGrantMatches, type RepairGrant } from "./callback-continuation.js";
import { claimSideEffect, finalizeSideEffect, getSideEffectReceipt } from "./reliability.js";
import { projectConfigSchema, workflowSchema } from "../../agent-registry/src/schemas.js";
import { canonicalJsonHash } from "../../policy-engine/src/index.js";

test("fresh related attempts share presentation across real worktrees without inheriting authority", async t => {
  const fixtureUrl = process.env.TEST_DATABASE_URL;
  assert.ok(fixtureUrl && process.env.DATABASE_URL === fixtureUrl,
    "Use the repository-owned disposable database wrapper");
  const database = new URL(fixtureUrl).pathname.slice(1);
  assert.match(database, /^agentflow_suite_test_[a-f0-9]{32}$/u);
  await withClient(async client => {
    assert.equal((await client.query("select current_database() name")).rows[0].name, database);
  });

  const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fresh-family-fixture-")));
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }));
  const hooks = path.join(fixture, "empty-hooks"), gitConfig = path.join(fixture, "empty-git-config");
  await fs.mkdir(hooks);
  await fs.writeFile(gitConfig, "");
  const git = (cwd: string, args: string[]) => execFileSync("git", [
    "-c", `core.hooksPath=${hooks}`, "-c", `init.templateDir=${hooks}`, ...args
  ], { cwd, encoding: "utf8", stdio: "pipe", env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: "0"
  } });
  const roots = ["main", "attempt-two", "attempt-three", "rejected-worktree", "foreign-project"]
    .map(name => path.join(fixture, name));
  await fs.mkdir(roots[0]);
  git(roots[0], ["init", "-q"]);
  await fs.mkdir(path.join(roots[0], "src"));
  await fs.writeFile(path.join(roots[0], "src/first.ts"), "export const first = 1;\n");
  await fs.writeFile(path.join(roots[0], "src/second.ts"), "export const second = 2;\n");
  git(roots[0], ["add", "src"]);
  git(roots[0], ["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic local fixture"]);
  for (const root of roots.slice(1, 4)) git(roots[0], ["worktree", "add", "--detach", root]);
  await fs.mkdir(roots[4]);
  git(roots[4], ["init", "-q"]);
  git(roots[4], ["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Separate synthetic project"]);
  for (const root of roots) assert.equal(git(root, ["status", "--porcelain=v1"]), "");

  const workflow = workflowSchema.parse({
    id: "fresh-family-" + randomUUID(), name: "Synthetic fresh attempt family",
    description: "Read-only admission and presentation fixture", lead: "implementation-agent",
    execution: { kind: "read-only" },
    stages: [{ id: "inspect", agent: "implementation-agent", goal: "Inspect bounded synthetic source", output: "evidence" }]
  });
  await withClient(client => client.query(`insert into agents(id,display_name,category,source_path,definition)
    values('implementation-agent','Synthetic implementer','test','synthetic','{}'),
      ('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}') on conflict(id) do nothing`));
  await api.seedRegistry([], [{ path: "synthetic/fresh-family.yaml", value: workflow }]);

  const chat = randomUUID(), originalTask = "Inspect one bounded synthetic outcome";
  const makeInput = (root: string, label: string, sourcePaths: string[], relatedRunId?: string): api.CreateRunInput => {
    const config = projectConfigSchema.parse({
      project: { name: "Synthetic family fixture", autonomy: 2 },
      actions: { allowed_write_paths: sourcePaths, allowed_commands: ["node --version"], blocked_commands: [] }
    });
    return {
      projectName: config.project.name, projectRootUri: root, projectProfile: "test", projectConfig: config,
      workflow, task: originalTask, autonomy: "2", policyProfile: "local", policySnapshot: config,
      policySnapshotHash: canonicalJsonHash(config), requester: "synthetic-human", requesterChannel: "test",
      evaluationMetadata: {
        originClient: "codex", codexThreadId: chat, noAutomaticRepeat: true,
        syntheticRequestNonce: randomUUID(),
        taskGrant: { authority: "direct-human", instruction: "Fresh synthetic attempt " + label, sourceWritePaths: sourcePaths }
      },
      ...(relatedRunId ? { relatedRunId, relatedRunReason: "Explicit new attempt at the same bounded synthetic outcome" } : {})
    };
  };
  const settle = async (runId: string, projectRootUri: string, completed = false) => {
    const claimed = await api.claimNextWorkflowTask({ runId, projectRootUri, workerId: "synthetic-family-worker" });
    assert.ok(claimed);
    const identity = { taskId: claimed.taskId, runId, workerId: claimed.workerId!, fencingToken: claimed.fencingToken };
    await api.startWorkflowTask(identity);
    if (completed) {
      await api.completeWorkflowTask({ ...identity, agentId: claimed.agentId,
        summary: "Synthetic attempt completed", artifact: { findings: ["Synthetic current-source observation"] } });
    } else {
      await api.blockWorkflowTask({ ...identity, agentId: claimed.agentId,
        summary: "Synthetic attempt remains blocked", reason: "Synthetic prerequisite remains open",
        artifact: { outcome: "blocked", summary: "Synthetic prerequisite remains open" } });
    }
    return claimed;
  };

  const inputA = makeInput(roots[0], "one", ["src/first.ts"]);
  const a = await api.createWorkflowRun(inputA), taskA = await settle(a.runId, roots[0]);
  const inputB = makeInput(roots[1], "two", ["src/second.ts"], a.runId);
  const b = await api.createWorkflowRun(inputB), taskB = await settle(b.runId, roots[1]);
  const inputC = makeInput(roots[2], "three", [], b.runId);
  const c = await api.createWorkflowRun(inputC);
  await settle(c.runId, roots[2], true);
  const unrelatedInput = { ...makeInput(roots[0], "different-outcome", ["src/first.ts"]), task: "Inspect another independent synthetic outcome" };
  const unrelated = await api.createWorkflowRun(unrelatedInput);
  await settle(unrelated.runId, roots[0]);
  // Even identical wording and the same chat are not an explicit relation.
  const unlinked = await api.createWorkflowRun(makeInput(roots[2], "unlinked-identical-text", []));
  await settle(unlinked.runId, roots[2]);
  const runIds = [a.runId, b.runId, c.runId, unrelated.runId, unlinked.runId];
  assert.equal(new Set(runIds).size, 5, "Every fixture request must be a distinct admission");
  for (const run of [a, b, c, unrelated, unlinked]) assert.notEqual(run.deduplicated, true);

  await t.test("real registration preserves three execution scopes and independent frozen grants", async () => {
    assert.equal(new Set([a.projectId, b.projectId, c.projectId]).size, 3);
    const locations = await withClient(async client => (await client.query(
      "select project_id::text,identity_id::text from project_identity_locations where project_id=any($1::uuid[])",
      [[a.projectId, b.projectId, c.projectId]])).rows);
    assert.equal(locations.length, 3);
    assert.ok(locations.every(row => row.identity_id === a.projectId));
    const details = await Promise.all([a, b, c].map(async run => {
      const detail = await api.getWorkflowRunDetails(run.runId);
      assert.ok(detail.run, "Admitted run must exist");
      return { ...detail, run: detail.run };
    }));
    assert.equal(new Set(details.map(detail => detail.run.runSetId)).size, 3, "Presentation linkage must not inherit run sets");
    for (const [index, input] of [inputA, inputB, inputC].entries()) {
      const detail = details[index];
      assert.equal(detail.tasks.length, 1);
      assert.equal(detail.tasks[0].attempts, 1);
      assert.equal(detail.run.projectRootUri, input.projectRootUri);
      assert.equal(detail.run.policySnapshotHash, input.policySnapshotHash);
      assert.deepEqual(detail.run.evaluationMetadata.taskGrant, input.evaluationMetadata!.taskGrant);
      for (const key of ["sourceRunId", "replayOfRunId", "parentRunId", "repairOriginRunId", "acceptanceContract"])
        assert.equal(detail.run.evaluationMetadata[key], undefined, "Fresh relation cannot inherit " + key);
      assert.equal((await api.verifyRunReceiptChain(detail.run.id)).valid, true);
    }
    for (const run of [b, c]) {
      assert.ok(details.find(detail => detail.run.id === run.runId)!.run.evaluationMetadata.queueFamilyLink);
      const receipts = await withClient(async client => (await client.query(
        "select receipt_hash from action_receipts where run_id=$1 and action_type='fresh_run_family_linked'", [run.runId])).rows);
      assert.equal(receipts.length, 1);
      assert.match(receipts[0].receipt_hash, /^[a-f0-9]{64}$/u);
    }
  });

  await t.test("approval, side-effect and callback authority remain exact to each attempt", async () => {
    const approval = (runId: string, taskId: string) => api.requestActionApproval({
      runId, taskId, stageId: "inspect", agentId: "implementation-agent", actionType: "local_command",
      target: "node --version", rationale: "Synthetic request belongs to its own attempt", policyDecision: { approvalRequired: true },
      payload: { commandLine: "node --version" }, idempotencyKey: "same-synthetic-request"
    });
    const approvalA = await approval(a.runId, taskA.taskId);
    const decision = await api.decideActionApproval({ approvalId: approvalA.approvalId, decision: "approved", actor: "synthetic-human", actorRole: "operator" });
    assert.equal(decision?.status, "approved");
    assert.equal((await api.listActionApprovals({ runId: b.runId })).length, 0);
    assert.equal((await api.listActionApprovals({ runId: c.runId })).length, 0);
    const approvalB = await approval(b.runId, taskB.taskId);
    assert.notEqual(approvalB.approvalId, approvalA.approvalId);
    assert.equal((await api.getActionApproval(approvalA.approvalId))!.status, "approved");
    assert.equal((await api.getActionApproval(approvalB.approvalId))!.status, "pending");

    const effect = (runId: string) => ({ projectId: runId, operation: "local_command", target: "node --version", idempotencyKey: "same-synthetic-effect" });
    const claimA = await claimSideEffect(effect(a.runId));
    assert.equal(claimA.status, "claimed");
    assert.equal(await finalizeSideEffect({ ...effect(a.runId), claimToken: claimA.claimToken!, receipt: { synthetic: "first-attempt-only" } }), true);
    assert.equal(await getSideEffectReceipt(effect(b.runId)), null);
    assert.equal(await getSideEffectReceipt(effect(c.runId)), null);
    const claimB = await claimSideEffect(effect(b.runId));
    assert.equal(claimB.status, "claimed", "A related attempt must not reuse the first completed effect");
    assert.equal(await finalizeSideEffect({ ...effect(b.runId), claimToken: claimA.claimToken!, receipt: { synthetic: "wrong-owner" } }), false);
    assert.equal(await finalizeSideEffect({ ...effect(b.runId), claimToken: claimB.claimToken!, receipt: { synthetic: "second-attempt-only" } }), true);
    const grant: RepairGrant = { version: 1, enabled: true, projectRootUri: roots[0], originTaskId: chat,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      runs: [{ runId: a.runId, taskHash: acceptanceDigest(originalTask) }] };
    for (const run of [a, b, c]) {
      const detail = await api.getWorkflowRunDetails(run.runId);
      assert.ok(detail.run, "Admitted run must exist");
      assert.equal(repairGrantMatches(grant, { id: run.runId, task: detail.run.task,
        projectRootUri: detail.run.projectRootUri, metadata: detail.run.evaluationMetadata }), run.runId === a.runId);
    }
  });

  const storedRows = () => withClient(async client => {
    const rows: Record<string, unknown> = {};
    for (const [name, sql, values] of [
      ["projects", "select to_jsonb(p) value from projects p where root_uri=any($1::text[]) order by id", [roots]],
      ["runs", "select to_jsonb(r) value from workflow_runs r where id=any($1::uuid[]) order by id", [runIds]],
      ["tasks", "select to_jsonb(t) value from workflow_tasks t where run_id=any($1::uuid[]) order by id", [runIds]],
      ["approvals", "select to_jsonb(a) value from action_approvals a where run_id=any($1::uuid[]) order by id", [runIds]],
      ["effects", "select to_jsonb(e) value from side_effect_receipts e where project_id=any($1::text[]) order by project_id,idempotency_key", [runIds]],
      ["receipts", "select to_jsonb(r) value from action_receipts r where run_id=any($1::uuid[]) order by created_at,id", [runIds]],
      ["artifacts", "select to_jsonb(a) value from artifacts a where run_id=any($1::uuid[]) order by id", [runIds]]
    ] as const) rows[name] = (await client.query(sql, [...values])).rows;
    return rows;
  });

  await t.test("public queue and history reads group explicit attempts without settling old work", async () => {
    const before = await storedRows();
    const allCards = await api.listWorkflowQueue(500, { latestRelated: true });
    const owned = new Set(runIds);
    const ownedCards = allCards.filter(card => card.familyAttempts?.some(attempt => owned.has(attempt.id)));
    assert.equal(ownedCards.length, 3, "Related family and two unlinked requests remain distinct");
    for (const separate of [unrelated, unlinked]) {
      assert.deepEqual(ownedCards.find(card => card.runId === separate.runId)!.familyAttempts!.map(attempt => attempt.id), [separate.runId]);
    }
    for (const root of roots.slice(0, 3)) {
      const cards = await api.listWorkflowQueue(100, { projectRootUri: root, latestRelated: true });
      const families = cards.filter(card => card.familyAttempts?.some(attempt => attempt.id === a.runId));
      assert.equal(families.length, 1, "Every related worktree exposes the same single family");
      const family = families[0];
      assert.equal(family.runId, b.runId, "Completed latest attempt cannot silently hide older blocked attempts");
      assert.equal(family.relatedRunCount, 3);
      assert.deepEqual(family.familyAttempts!.map(attempt => attempt.id).sort(), [a.runId, b.runId, c.runId].sort());
      assert.equal(family.familyAttempts!.find(attempt => attempt.id === c.runId)!.status, "completed");
    }
    const history = await api.listWorkflowRuns(100, { relatedRunId: c.runId });
    assert.deepEqual(history.map(run => run.id).sort(), [a.runId, b.runId, c.runId].sort());
    assert.equal(history.find(run => run.id === a.runId)!.status, "blocked");
    assert.equal(history.find(run => run.id === b.runId)!.status, "blocked");
    assert.equal(history.find(run => run.id === c.runId)!.status, "completed");
    assert.deepEqual(await storedRows(), before, "Display grouping cannot modify ownership, grants, approvals, effects, tasks or history");
  });

  await t.test("invalid or metadata-injected links roll back admission and registration atomically", async t => {
    const state = async () => ({
      ...await withClient(async client => ({
        projects: (await client.query("select to_jsonb(p) value from projects p where root_uri=any($1::text[]) order by id", [roots])).rows,
        runs: (await client.query("select to_jsonb(r) value from workflow_runs r join projects p on p.id=r.project_id where p.root_uri=any($1::text[]) order by r.id", [roots])).rows,
        locations: (await client.query("select to_jsonb(l) value from project_identity_locations l join projects p on p.id=l.project_id where p.root_uri=any($1::text[]) order by l.project_id", [roots])).rows,
        events: (await client.query("select to_jsonb(e) value from project_identity_events e order by e.sequence")).rows
      })), original: await storedRows()
    });
    const rejectionCases: Array<[string, (input: api.CreateRunInput) => void]> = [
      ["missing referenced run", input => { input.relatedRunId = randomUUID(); }],
      ["missing relation reason", input => { delete input.relatedRunReason; }],
      ["missing requester actor", input => { delete input.requester; }],
      ["metadata-injected relation", input => {
        delete input.relatedRunId; delete input.relatedRunReason;
        input.evaluationMetadata = { ...input.evaluationMetadata, queueFamilyLink: { relatedRunId: a.runId, authority: "direct-human" } };
      }]
    ];
    for (const [label, mutate] of rejectionCases) await t.test(label, async () => {
      const input = makeInput(roots[3], "rejected", ["src/first.ts"], a.runId); mutate(input);
      const before = await state();
      await assert.rejects(api.createWorkflowRun(input));
      assert.deepEqual(await state(), before, "A rejected relation must not leave a project, run, location, event or changed source history");
    });
    await t.test("a different Git identity cannot join by copied relation", async () => {
      const before = await state();
      await assert.rejects(api.createWorkflowRun(makeInput(roots[4], "foreign", ["src/first.ts"], a.runId)));
      assert.deepEqual(await state(), before);
    });
  });
  for (const root of roots) assert.equal(git(root, ["status", "--porcelain=v1"]), "");
});
