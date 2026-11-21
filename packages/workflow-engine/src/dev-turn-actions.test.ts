import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { loadProjectConfig } from "../../agent-registry/src/loaders.js";
import { resolveExecutionPolicy } from "../../policy-engine/src/index.js";
import {
  addDevSessionTurn,
  createDevSession,
  decideDevSessionApproval,
  listApprovedDevSessionApprovals,
  listDevSessionApprovals,
  listDevSessionDiffs,
  listDevSessionReceipts,
  listDevSessionTurns
} from "../../storage/src/dev-sessions.js";
import { DEV_MODE_MAX_ITERATIONS, runDirectTurn, type DevTurnEvent } from "./direct-turn.js";
import { executeDevTurnActions } from "./dev-turn-actions.js";

const projectDir = fileURLToPath(new URL("../../../templates/project", import.meta.url));

async function setupSession(title: string) {
  const project = await loadProjectConfig(projectDir);
  const session = await createDevSession({ projectRootUri: projectDir, provider: "mock", title });
  return { project, session };
}

test("an allowed command executes under trusted-personal and is not re-run in the same turn", async () => {
  const { project, session } = await setupSession("Echo command test");
  const events: DevTurnEvent[] = [];
  const result = await runDirectTurn({
    session,
    projectDir,
    project,
    message: "Run the check [request-command:echo hello dev]",
    maxIterations: DEV_MODE_MAX_ITERATIONS,
    toolsEnabled: true,
    onEvent: (event) => {
      events.push(event);
    }
  });
  assert.equal(result.stoppedReason, "completed");
  assert.equal(result.iterations, 2);
  assert.deepEqual(result.deferredActions, []);
  assert.ok(events.some((event) => event.type === "tool_call" && event.tool === "local_command" && event.status === "executed"));
  const receipts = await listDevSessionReceipts(session.id);
  assert.equal(receipts.filter((receipt) => receipt.actionType === "dev_command_executed").length, 1);
  assert.ok(receipts.some((receipt) => receipt.actionType === "dev_turn_completed"));
});

test("a blocked command is rejected, receipted, and never runs", async () => {
  const { project, session } = await setupSession("Blocked command test");
  const events: DevTurnEvent[] = [];
  const result = await runDirectTurn({
    session,
    projectDir,
    project,
    message: "Push it [request-command:git push origin master]",
    maxIterations: DEV_MODE_MAX_ITERATIONS,
    toolsEnabled: true,
    onEvent: (event) => {
      events.push(event);
    }
  });
  assert.equal(result.stoppedReason, "completed");
  assert.equal(result.deferredActions.length, 1);
  assert.equal(result.deferredActions[0].kind, "command");
  assert.equal(result.deferredActions[0].status, "rejected");
  assert.match(result.deferredActions[0].detail ?? "", /blocked pattern: git push/);
  assert.ok(events.some((event) => event.type === "tool_call" && event.status === "rejected"));
  const receipts = await listDevSessionReceipts(session.id);
  assert.ok(receipts.some((receipt) => receipt.actionType === "dev_command_rejected"));
});

test("a dangerous interpreter flag pauses the turn until the owner approves it inline", async () => {
  const { project, session } = await setupSession("Approval pause test");
  const command = 'python3 -c "print(approved)"';
  const events: DevTurnEvent[] = [];
  const paused = await runDirectTurn({
    session,
    projectDir,
    project,
    message: `Run this [request-command:${command}]`,
    maxIterations: DEV_MODE_MAX_ITERATIONS,
    toolsEnabled: true,
    onEvent: (event) => {
      events.push(event);
    }
  });
  assert.equal(paused.stoppedReason, "awaiting_approval");
  assert.ok(paused.awaitingApproval);
  assert.equal(paused.awaitingApproval.actionType, "local_command");
  assert.equal(paused.awaitingApproval.target, command);
  assert.ok(events.some((event) => event.type === "turn_awaiting_approval"));
  const turns = await listDevSessionTurns(session.id);
  assert.equal(turns.at(-1)?.status, "awaiting_approval");

  const approvals = await listDevSessionApprovals(session.id);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  const decided = await decideDevSessionApproval({ approvalId: approvals[0].id, decision: "approved", decidedBy: "test" });
  assert.equal(decided?.status, "approved");

  const resumedEvents: DevTurnEvent[] = [];
  const resumed = await runDirectTurn({
    session,
    projectDir,
    project,
    message: `Continue with the approved local_command: ${command} [request-command:${command}]`,
    maxIterations: DEV_MODE_MAX_ITERATIONS,
    toolsEnabled: true,
    onEvent: (event) => {
      resumedEvents.push(event);
    }
  });
  assert.equal(resumed.stoppedReason, "completed");
  assert.ok(resumedEvents.some((event) => event.type === "tool_call" && event.status === "executed"));
  assert.deepEqual(await listApprovedDevSessionApprovals(session.id), []);
});

test("a requested file write becomes a proposed diff and never touches disk", async () => {
  const { project, session } = await setupSession("Diff proposal test");
  const probePath = path.join(projectDir, "src/dev-mode-probe2.txt");
  await fs.rm(probePath, { force: true });
  const events: DevTurnEvent[] = [];
  const result = await runDirectTurn({
    session,
    projectDir,
    project,
    message: "Draft the file [write-file:src/dev-mode-probe2.txt::hello dev mode]",
    maxIterations: DEV_MODE_MAX_ITERATIONS,
    toolsEnabled: true,
    onEvent: (event) => {
      events.push(event);
    }
  });
  assert.equal(result.diffIds.length, 1);
  assert.ok(events.some((event) => event.type === "diff_proposed" && event.path === "src/dev-mode-probe2.txt"));
  await assert.rejects(fs.stat(probePath), /ENOENT/);
  const diffs = await listDevSessionDiffs(session.id);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, "src/dev-mode-probe2.txt");
  assert.equal(diffs[0].proposedContent, "hello dev mode");
  assert.equal(diffs[0].status, "proposed");
  assert.match(diffs[0].diffText, /--- \/dev\/null/);
  assert.match(diffs[0].diffText, /\+hello dev mode/);
});

test("executeDevTurnActions reads files through the policy-checked reader", async () => {
  const { project, session } = await setupSession("Direct read test");
  const turn = await addDevSessionTurn({ sessionId: session.id, role: "assistant", content: "", status: "running" });
  const resolved = resolveExecutionPolicy(project, "trusted-personal").project;
  const toolResults: string[] = [];
  const outcome = await executeDevTurnActions({
    session,
    turnId: turn.id,
    projectDir,
    project: resolved,
    output: { summary: "read", artifact: {}, requestedFileReads: ["AGENTS.md"] },
    approvedActions: new Map(),
    seenActions: new Set(),
    onEvent: () => {},
    toolResults,
    deferredActions: [],
    diffIds: []
  });
  assert.deepEqual(outcome, { continued: true, progress: true });
  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0], /Read AGENTS\.md/);
});
