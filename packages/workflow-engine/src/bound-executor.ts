import { createHash } from "node:crypto";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { assertExecutorRegistration, executeExecutorSnapshot, type ExecutorOperation, type ExecutorResult } from "../../executor-adapters/src/index.js";
import { evaluateActionApprovalRule, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
import { blockWorkflowTask, completeWorkflowTask, findRunActionByIdempotencyKey, recordRunAction, requestActionApproval, type ClaimedWorkflowTask } from "../../storage/src/postgres.js";
const hashText = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function executeBoundExecutorStage(task: ClaimedWorkflowTask, project: ProjectConfig, assertLeaseOwned: () => Promise<void> = async () => {}): Promise<void> {
  if (!task?.executorSnapshot) throw new Error("Executor stage is missing immutable executor evidence.");
  if (task.executorSnapshot.registeredProjectRoot !== task.projectRootUri) throw new Error("Executor snapshot project root does not match the registered workflow project.");
  assertExecutorRegistration(task.executorSnapshot, project, task.projectRootUri);
  const commandLine = operationCommand(task.executorSnapshot.operation);
  assertCommandAllowed(commandLine, project);
  const approvalTarget = executorApprovalTarget(task.executorSnapshot);
  try {
    const previous = await findRunActionByIdempotencyKey({
      runId: task.runId,
      artifactKind: "executor_output",
      idempotencyKey: task.executorSnapshot.snapshotHash
    });
    const previousExecution = previous?.content.execution as { status?: string } | undefined;
    if (previous && previousExecution?.status === "passed") {
      await assertLeaseOwned();
      const reuseArtifactUri = await recordRunAction({
        runId: task.runId,
        taskId: task.taskId,
        agentId: task.agentId,
        actionType: "executor_adapter_reused",
        target: `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}`,
        summary: `Skipped duplicate executor request; reused receipt ${previous.uri}.`,
        artifactKind: "action_reuse",
        artifactContent: { snapshot: task.executorSnapshot, originalArtifactUri: previous.uri }
      });
      await completeWorkflowTask({
        taskId: task.taskId,
        runId: task.runId,
        agentId: task.agentId,
        workerId: task.workerId!,
        fencingToken: task.fencingToken,
        summary: `Reused ${task.executorSnapshot.operation} result from ${previous.uri}.`,
        artifact: { executor: task.executorSnapshot, execution: previous.content.execution, actionResults: [{ type: "executor_adapter_reused", artifactUri: previous.uri, reuseArtifactUri }] }
      });
      return;
    }
    await assertLeaseOwned();
    const gated = await runExecutorApprovalGate({
      project,
      target: approvalTarget,
      approved: false,
      execute: () => executeExecutorSnapshot(task.executorSnapshot!, {
        localFallback: task.executorSnapshot!.localFallback === "explicit"
          ? async () => localFallbackResult(commandLine, task.projectRootUri, project, task.executorSnapshot!.requestedHost)
          : undefined
      })
    });
    if (gated.status === "pending") {
        const approval = await requestActionApproval({
          runId: task.runId,
          taskId: task.taskId,
          stageId: task.stageId,
          agentId: task.agentId,
          actionType: "executor_adapter",
          target: approvalTarget,
          rationale: `Policy requires approval before executing ${approvalTarget}.`,
          policyDecision: {
            approvalRequired: true,
            allowedByPolicy: true,
            policyProfile: project.execution.policy_profile
          },
          payload: {
            snapshot: task.executorSnapshot,
            commandLine,
            payloadHash: hashText(JSON.stringify(task.executorSnapshot))
          },
          idempotencyKey: task.executorSnapshot.snapshotHash
        });
        await blockWorkflowTask({
          taskId: task.taskId,
          runId: task.runId,
          agentId: task.agentId,
          workerId: task.workerId!,
          fencingToken: task.fencingToken,
          summary: `Approval pending for ${approvalTarget}.`,
          reason: `Required executor action ${approvalTarget} is awaiting approval.`,
          artifact: { executor: task.executorSnapshot, actionResults: [{ type: "executor_adapter_approval_pending", approvalId: approval.approvalId, artifactUri: approval.artifactUri, status: approval.status }] }
        });
        return;
    }
    const executorApprovalRule = gated.approvalRule;
    await assertLeaseOwned();
    const execution = gated.result;
    const artifactUri = await recordRunAction({
      runId: task.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      actionType: "executor_adapter",
      target: `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}`,
      summary: `${execution.status} on ${execution.executionHost}${execution.fallbackUsed ? " via explicit local fallback" : ""}`,
      artifactKind: "executor_output",
      artifactContent: { snapshot: task.executorSnapshot, execution, approvalRule: executorApprovalRule ?? undefined },
      idempotencyKey: task.executorSnapshot.snapshotHash
    });
    if (execution.status !== "passed") throw new Error(`Executor ${task.executorSnapshot.executorId} failed on ${execution.executionHost}.`);
    await completeWorkflowTask({
      taskId: task.taskId,
      runId: task.runId,
      agentId: task.agentId,
      workerId: task.workerId!,
      fencingToken: task.fencingToken,
      summary: `Executed ${task.executorSnapshot.operation} on ${execution.executionHost}.`,
      artifact: { executor: task.executorSnapshot, execution, actionResults: [{ type: "executor_adapter", artifactUri }] }
    });
  } catch (error) {
    await recordRunAction({
      runId: task.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      actionType: "executor_adapter_failed",
      target: `${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}`,
      summary: error instanceof Error ? error.message : String(error),
      artifactKind: "executor_failure",
      artifactContent: { snapshot: task.executorSnapshot, error: error instanceof Error ? error.message : String(error) },
      idempotencyKey: `${task.executorSnapshot.snapshotHash}:failure`
    });
    throw error;
  }
}

export function executorApprovalTarget(snapshot: { executorId: string; operation: string; requestedHost: string; revision: string; registeredProjectRoot: string }): string {
  return `${snapshot.executorId}/${snapshot.operation}@${snapshot.requestedHost}#${snapshot.revision}:${snapshot.registeredProjectRoot}`;
}

export async function runExecutorApprovalGate<T>(input: {
  project: ProjectConfig;
  target: string;
  approved: boolean;
  execute: () => Promise<T>;
}): Promise<{ status: "pending" } | { status: "executed"; result: T; approvalRule: ActionApprovalRuleMatch | null }> {
  const approvalRule = input.project.policies.require_approval_for_external_actions
    ? evaluateActionApprovalRule({ project: input.project, actionType: "executor_adapter", target: input.target })
    : null;
  if (input.project.policies.require_approval_for_external_actions && !input.approved && !approvalRule) return { status: "pending" };
  return { status: "executed", result: await input.execute(), approvalRule };
}

export function operationCommand(operation: ExecutorOperation): string {
  return operation === "typecheck" ? "npm run typecheck" : operation === "validate" ? "npm run validate" : "npm test";
}

export async function localFallbackResult(commandLine: string, cwd: string, project: ProjectConfig, requestedHost: string): Promise<ExecutorResult> {
  const result = await executeAllowedCommand({ commandLine, cwd, project });
  return {
    ...result,
    status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
    requestedHost,
    executionHost: "local",
    fallbackUsed: true,
    artifactReference: null
  };
}
