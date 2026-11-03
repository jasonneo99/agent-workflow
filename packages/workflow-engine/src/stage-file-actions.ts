import fs from "node:fs/promises";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertFileWriteAllowed } from "../../local-tools/src/file-writer.js";
import { assertFilePatchAllowed, executeAllowedFileMutation, normalizeRequestedFileMutation, summarizeFileMutation, oversizedReplacementPatchHint } from "../../local-tools/src/file-patcher.js";
import { executeAllowedFileRead } from "../../local-tools/src/file-reader.js";
import { fileReadDelta, type StateDelta } from "../../model-providers/src/state-deltas.js";
import { executeWithProviderFallback, type ProviderFallbackAttempt } from "../../model-providers/src/index.js";
import type { scoreStageOutput } from "../../model-providers/src/quality.js";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";
import { evaluateActionApprovalRule, evaluateActionRiskAutoApproval, type ActionApprovalRuleMatch } from "../../policy-engine/src/index.js";
import { claimSideEffect, dismissSupersededActionApprovals, finalizeSideEffect, findRunActionByIdempotencyKey, recordRunAction, requestActionApproval, withProjectExecutionLock, type ClaimedWorkflowTask } from "../../storage/src/postgres.js";
import type { PreparedTaskExecution } from "./run-preparation.js";
import { actionIdempotencyKey, hashText, normalizeActionText, recordBoundedReactLoopReceipt } from "./action-receipts.js";
import { isRecoverableFileMutationFailure, prepareRejectedPatchRetry } from "./file-mutation-retry.js";
import { recordDirectProviderUsage } from "./fleet-usage.js";

type StagePattern = NonNullable<StageExecutionInput["stagePattern"]>;
type StageReads = NonNullable<StageExecutionInput["fileReads"]>;
type FallbackInput = Parameters<typeof executeWithProviderFallback>[0];
interface StageFileContext {
  task: ClaimedWorkflowTask;
  project: ProjectConfig;
  stagePattern: StagePattern;
  localProjectRootUri: string;
  actionResults: unknown[];
  stageFileReads: StageReads;
  stageStateDeltas: StateDelta[];
  assertLeaseOwned: () => Promise<void>;
}
export interface StageFileWriteState {
  output: StageExecutionOutput;
  quality: ReturnType<typeof scoreStageOutput>;
  fallbackAttempts: ProviderFallbackAttempt[];
  actualProviderId: Awaited<ReturnType<typeof executeWithProviderFallback>>["actualProvider"];
  actualModel: Awaited<ReturnType<typeof executeWithProviderFallback>>["actualModel"];
  mutationRetriesRemaining: number;
  reactIteration: number;
}
interface StageFileWriteResult { retryRequested: boolean; state: StageFileWriteState }

export function isInternalWorkflowReceiptWrite(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return /^\.agent-workflow\/receipts\/[a-zA-Z0-9._/-]+\.(?:md|json)$/u.test(normalized)
    && !normalized.split("/").includes("..");
}

/** Keep read deduplication and observation counters local to one stage. */
export function createStageFileReader(input: StageFileContext) {
  const { task, project, stagePattern, localProjectRootUri, actionResults,
    stageFileReads, stageStateDeltas, assertLeaseOwned } = input;
  const seenReadPaths = new Set<string>();
  let fileReadIteration = 0;
  const fulfillFileReadRequests = async (readPaths: string[], totalRequestedActions: number): Promise<number> => {
    const pendingReads = readPaths.filter((readPath) => {
      const key = readPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
      if (!key || seenReadPaths.has(key)) return false;
      seenReadPaths.add(key);
      return true;
    });
    for (const readPath of pendingReads) {
      await assertLeaseOwned();
      fileReadIteration += 1;
      const fileReadIdempotencyKey = actionIdempotencyKey({
        taskId: task.taskId,
        stageId: task.stageId,
        agentId: task.agentId,
        actionType: "file_read",
        target: readPath,
        payload: readPath,
        normalizePayload: true
      });
      const readReceiptBase = {
        task,
        stagePattern,
        iteration: fileReadIteration,
        totalRequestedActions,
        actionType: "file_read" as const,
        target: readPath,
        payloadHash: hashText(normalizeActionText(readPath))
      };
      try {
        const readResult = await executeAllowedFileRead({ relativePath: readPath, cwd: localProjectRootUri, project });
        const readArtifactUri = await recordRunAction({
          runId: task.runId,
          taskId: task.taskId,
          agentId: task.agentId,
          actionType: "file_read",
          target: readResult.relativePath,
          summary: `Read ${readResult.bytesRead} bytes from \`${readResult.relativePath}\`${readResult.truncated ? " (truncated at policy max)" : ""}.`,
          artifactKind: "file_read",
          artifactContent: {
            actionType: "file_read",
            path: readResult.relativePath,
            bytesRead: readResult.bytesRead,
            truncated: readResult.truncated,
            sha256: readResult.sha256,
            lineRange: readResult.lineRange,
            contentPreview: readResult.content.slice(0, 20000),
            requestedByTaskId: task.taskId,
            requestedByStageId: task.stageId
          },
          idempotencyKey: fileReadIdempotencyKey
        });
        stageFileReads.push({ path: readPath, content: readResult.content, truncated: readResult.truncated, sha256: readResult.sha256 });
        stageStateDeltas.push(fileReadDelta({
          path: readResult.relativePath,
          bytesRead: readResult.bytesRead,
          truncated: readResult.truncated,
          sha256: readResult.sha256,
          provenance: { stageId: task.stageId, agentId: task.agentId, actionType: "file_read", taskId: task.taskId, artifactUri: readArtifactUri }
        }));
        actionResults.push({ type: "file_read", path: readResult.relativePath, artifactUri: readArtifactUri,
          bytesRead: readResult.bytesRead, truncated: readResult.truncated });
        await recordBoundedReactLoopReceipt({
          ...readReceiptBase,
          policyDecision: { status: "allowed", approvalRequired: false, allowedByPolicy: true, policyProfile: project.execution.policy_profile },
          resultReceipt: { status: "completed", artifactUri: readArtifactUri, bytesRead: readResult.bytesRead, truncated: readResult.truncated }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const denialArtifactUri = await recordRunAction({
          runId: task.runId,
          taskId: task.taskId,
          agentId: task.agentId,
          actionType: "file_read_rejected",
          target: readPath,
          summary: message,
          artifactKind: "action_rejection",
          artifactContent: { actionType: "file_read", target: readPath, error: message,
            requestedByTaskId: task.taskId, requestedByStageId: task.stageId }
        });
        stageFileReads.push({ path: readPath, content: "", truncated: false, error: message });
        stageStateDeltas.push(fileReadDelta({ path: readPath, error: message,
          provenance: { stageId: task.stageId, agentId: task.agentId, actionType: "file_read_rejected", taskId: task.taskId, artifactUri: denialArtifactUri } }));
        actionResults.push({ type: "file_read_rejected", path: readPath, artifactUri: denialArtifactUri, error: message });
        await recordBoundedReactLoopReceipt({
          ...readReceiptBase,
          policyDecision: { status: "rejected", approvalRequired: false, allowedByPolicy: false, policyProfile: project.execution.policy_profile },
          resultReceipt: { status: "rejected", artifactUri: denialArtifactUri }
        });
      }
    }
    return pendingReads.length;
  };
  return { seenReadPaths, fulfillFileReadRequests };
}

/** Dispatch file effects under the caller's unchanged authority and retry budget.
 * A retry returns to the owning loop before dispatching refreshed action requests.
 */
export async function executeStageFileWrites(input: StageFileContext & {
  state: StageFileWriteState;
  totalRequestedActions: number;
  route: { providerId: string };
  routedStageInput: StageExecutionInput;
  fallbackPolicy: NonNullable<FallbackInput["policy"]>;
  guardedProviderFactory: NonNullable<FallbackInput["providerFactory"]>;
  assertStageGuard: (sideEffect: boolean) => Promise<void>;
  preparation?: PreparedTaskExecution;
  scoreOutput: (output: StageExecutionOutput) => ReturnType<typeof scoreStageOutput>;
}): Promise<StageFileWriteResult> {
  const { task, project, stagePattern, localProjectRootUri, actionResults,
    stageFileReads, stageStateDeltas, assertLeaseOwned, totalRequestedActions,
    route, routedStageInput, fallbackPolicy, guardedProviderFactory,
    assertStageGuard, preparation, scoreOutput } = input;
  let { output, quality, fallbackAttempts, actualProviderId, actualModel,
    mutationRetriesRemaining, reactIteration } = input.state;
  const result = (retryRequested: boolean): StageFileWriteResult => ({ retryRequested,
    state: { output, quality, fallbackAttempts, actualProviderId, actualModel,
      mutationRetriesRemaining, reactIteration } });
  for (const fileWrite of output.requestedFileWrites ?? []) {
    await assertLeaseOwned();
    reactIteration += 1;
    const mutation = normalizeRequestedFileMutation(fileWrite);
    if (!mutation) continue;
    const { isPatch, payload: filePayload, expectedHash, bytes: actionBytes } = mutation;
    const fileWriteIdempotencyKey = actionIdempotencyKey({
      taskId: task.taskId,
      stageId: task.stageId,
      agentId: task.agentId,
      actionType: "file_write",
      target: fileWrite.path,
      payload: mutation.idempotencyPayload
    });
    const previousWrite = await findRunActionByIdempotencyKey({
      runId: task.runId,
      artifactKind: "file_write",
      idempotencyKey: fileWriteIdempotencyKey
    });
    if (previousWrite) {
      const reuseArtifactUri = await recordRunAction({
        runId: task.runId,
        taskId: task.taskId,
        agentId: task.agentId,
        actionType: "file_write_reused",
        target: fileWrite.path,
        summary: `Skipped duplicate file write; reused receipt ${previousWrite.uri}.`,
        artifactKind: "action_reuse",
        artifactContent: {
          actionType: "file_write",
          target: fileWrite.path,
          originalArtifactUri: previousWrite.uri,
          requestedByTaskId: task.taskId,
          requestedByStageId: task.stageId
        }
      });
      actionResults.push({
        type: "file_write_reused",
        path: fileWrite.path,
        nextHash: typeof previousWrite.content.nextHash === "string" ? previousWrite.content.nextHash : undefined,
        artifactUri: previousWrite.uri,
        reuseArtifactUri
      });
      await recordBoundedReactLoopReceipt({
        task,
        stagePattern,
        iteration: reactIteration,
        totalRequestedActions,
        actionType: "file_write",
        target: fileWrite.path,
        payloadHash: hashText(filePayload),
        policyDecision: {
          status: "reused",
          approvalRequired: false,
          allowedByPolicy: true,
          policyProfile: project.execution.policy_profile
        },
        resultReceipt: {
          status: "reused",
          artifactUri: reuseArtifactUri,
          originalArtifactUri: previousWrite.uri
        }
      });
      continue;
    }

    let fileWriteApprovalRule: ActionApprovalRuleMatch | null = null;
    if (!isInternalWorkflowReceiptWrite(fileWrite.path)) {
      try {
        if (isPatch) assertFilePatchAllowed(fileWrite.path, filePayload, expectedHash!, project);
        else assertFileWriteAllowed(fileWrite.path, filePayload, project);
      } catch (error) {
        const policyError = error instanceof Error ? error.message : String(error);
        const rejectionArtifactUri = await recordRunAction({
          runId: task.runId,
          taskId: task.taskId,
          agentId: task.agentId,
          actionType: "file_write_rejected",
          target: fileWrite.path,
          summary: policyError,
          artifactKind: "action_rejection",
          artifactContent: {
            actionType: "file_write",
            target: fileWrite.path,
            error: policyError,
            requestedByTaskId: task.taskId,
            requestedByStageId: task.stageId
          }
        });
        const patchHint = !isPatch ? oversizedReplacementPatchHint(fileWrite.path,filePayload,project) : null;
        if(patchHint){
          actionResults.push({type:'file_write_rejected',path:fileWrite.path,error:policyError,recoveryHint:patchHint,artifactUri:rejectionArtifactUri});
          stageStateDeltas.push({op:'update',key:`file:${fileWrite.path}`,fact:patchHint,
            provenance:{stageId:task.stageId,agentId:task.agentId,actionType:'file_write',taskId:task.taskId,artifactUri:rejectionArtifactUri},assertedAt:new Date().toISOString()});
          if(mutationRetriesRemaining>0){
            mutationRetriesRemaining-=1;
            const boundedPath=`${fileWrite.path}#L1-L100`;
            const fresh=await executeAllowedFileRead({relativePath:boundedPath,cwd:localProjectRootUri,project});
            stageFileReads.push({path:boundedPath,content:fresh.content,truncated:fresh.truncated,sha256:fresh.sha256});
            await recordRunAction({runId:task.runId,taskId:task.taskId,agentId:task.agentId,actionType:'file_write_patch_reroute',target:fileWrite.path,
              summary:'Oversized replacement refused; returning bounded context and full preimage hash for a policy-allowed surgical patch.',artifactKind:'file_write_retry',
              artifactContent:{rejectionArtifactUri,previousHash:fresh.sha256,readPath:boundedPath,retriesRemaining:mutationRetriesRemaining,policyUnchanged:true}});
            await assertLeaseOwned();await assertStageGuard(false);
            const rerouteStartedAt=Date.now();
            const reroute=await executeWithProviderFallback({providerId:route.providerId,stageInput:{...routedStageInput,fileReads:stageFileReads,stateDeltas:stageStateDeltas},policy:{...fallbackPolicy,chains:{},maxRetries:0},providerFactory:guardedProviderFactory});
            await recordDirectProviderUsage({stage:routedStageInput,attempts:reroute.attempts,output:reroute.output,latencyMs:Date.now()-rerouteStartedAt}).catch(()=>0);
            fallbackAttempts=[...fallbackAttempts,...reroute.attempts];output=reroute.output;quality=scoreOutput(output);actualProviderId=reroute.actualProvider;actualModel=reroute.actualModel;
            return result(true);
          }
          continue;
        }
        const approval = await requestActionApproval({
          runId: task.runId,
          taskId: task.taskId,
          stageId: task.stageId,
          agentId: task.agentId,
          actionType: "project_policy_change",
          target: `actions.allowed_write_paths:${fileWrite.path}`,
          rationale: `The requested file is outside the project write allowlist. Approve this exact policy addition to continue ${task.stageId}.`,
          policyDecision: { approvalRequired: true, allowedByPolicy: false, policyProfile: project.execution.policy_profile },
          payload: { changeKind: "allowed_write_path", proposedRule: fileWrite.path, requestedActionType: "file_write", requestedTarget: fileWrite.path, policyError, rejectionArtifactUri },
          idempotencyKey: `policy-change-${fileWriteIdempotencyKey}`
        });
        actionResults.push({
          type: "project_policy_change_approval_pending",
          path: fileWrite.path,
          approvalId: approval.approvalId,
          artifactUri: rejectionArtifactUri,
          approvalArtifactUri: approval.artifactUri,
          error: policyError
        });
        await recordBoundedReactLoopReceipt({
          task,
          stagePattern,
          iteration: reactIteration,
          totalRequestedActions,
          actionType: "file_write",
          target: fileWrite.path,
          payloadHash: hashText(filePayload),
          policyDecision: {
            status: "approval_required",
            approvalRequired: true,
            allowedByPolicy: false,
            policyProfile: project.execution.policy_profile
          },
          resultReceipt: {
            status: "approval_pending",
            approvalId: approval.approvalId,
            artifactUri: rejectionArtifactUri,
            error: policyError
          }
        });
        continue;
      }
    }
    if (project.policies.require_approval_for_external_actions && !isInternalWorkflowReceiptWrite(fileWrite.path)) {
      fileWriteApprovalRule = evaluateActionApprovalRule({
        project,
        actionType: "file_write",
        target: fileWrite.path,
        bytes: actionBytes
      }) ?? evaluateActionRiskAutoApproval({
        project,
        actionType: "file_write",
        target: fileWrite.path,
        bytes: actionBytes
      });
      if (!fileWriteApprovalRule) {
        const approval = await requestActionApproval({
          runId: task.runId,
          taskId: task.taskId,
          stageId: task.stageId,
          agentId: task.agentId,
          actionType: "file_write",
          target: fileWrite.path,
          rationale: `Policy requires approval before writing a file requested by ${task.agentId} during ${task.stageId}.`,
          policyDecision: {
            approvalRequired: true,
            allowedByPolicy: true,
            policyProfile: project.execution.policy_profile
          },
          payload: {
            relativePath: fileWrite.path,
            bytes: actionBytes,
            payloadHash: hashText(filePayload),
            mode: isPatch ? "patch" : "replace",
            expectedHash,
            canonicalProjectRoot: await fs.realpath(localProjectRootUri),
            projectRootHash: hashText(await fs.realpath(localProjectRootUri))
          },
          idempotencyKey: fileWriteIdempotencyKey
        });
        actionResults.push({
          type: "file_write_approval_pending",
          path: fileWrite.path,
          approvalId: approval.approvalId,
          artifactUri: approval.artifactUri,
          status: approval.status
        });
        await recordBoundedReactLoopReceipt({
          task,
          stagePattern,
          iteration: reactIteration,
          totalRequestedActions,
          actionType: "file_write",
          target: fileWrite.path,
          payloadHash: hashText(filePayload),
          policyDecision: {
            status: "approval_required",
            approvalRequired: true,
            allowedByPolicy: true,
            policyProfile: project.execution.policy_profile
          },
          resultReceipt: {
            status: "approval_pending",
            approvalId: approval.approvalId,
            artifactUri: approval.artifactUri
          }
        });
        continue;
      }
    }

    await assertStageGuard(true);
    await preparation?.beforeWrite(fileWrite.path);
    const fileSideEffect = await claimSideEffect({ projectId: task.runId, idempotencyKey: fileWriteIdempotencyKey, operation: "file_write", target: fileWrite.path, claimSeconds: 3600 });
    if (fileSideEffect.status !== "claimed" || !fileSideEffect.claimToken) {
      actionResults.push({ type: `file_write_side_effect_${fileSideEffect.status}`, path: fileWrite.path, receipt: fileSideEffect.receipt });
      continue;
    }
    await assertLeaseOwned();
    let writeResult;
    try {
      writeResult = await withProjectExecutionLock(
        { projectRootUri: task.projectRootUri, resource: `file:${fileWrite.path.replace(/\\/gu, "/")}` },
        async () => {
          await recordRunAction({runId:task.runId,taskId:task.taskId,agentId:task.agentId,actionType:'execution_progress',target:fileWrite.path,summary:'Starting the governed file change; no successful write or acceptance is claimed.',artifactKind:'execution_progress',artifactContent:{operation:'file_write',status:'started',requestedByTaskId:task.taskId,requestedByStageId:task.stageId}});
          return executeAllowedFileMutation({ request: fileWrite, payload: filePayload, isPatch, expectedHash, cwd: localProjectRootUri, project });
        }
      );
    } catch (error) {
      const rejectionMessage = error instanceof Error ? error.message : String(error);
      const rejectionArtifactUri = await recordRunAction({
        runId: task.runId,
        taskId: task.taskId,
        agentId: task.agentId,
        actionType: "file_write_rejected",
        target: fileWrite.path,
        summary: rejectionMessage,
        artifactKind: "action_rejection",
        artifactContent: {
          actionType: "file_write",
          target: fileWrite.path,
          error: rejectionMessage,
          requestedByTaskId: task.taskId,
          requestedByStageId: task.stageId
        }
      });
      actionResults.push({
        type: "file_write_rejected",
        path: fileWrite.path,
        artifactUri: rejectionArtifactUri,
        error: rejectionMessage
      });
      await recordBoundedReactLoopReceipt({
        task,
        stagePattern,
        iteration: reactIteration,
        totalRequestedActions,
        actionType: "file_write",
        target: fileWrite.path,
        payloadHash: hashText(filePayload),
        policyDecision: {
          status: "rejected",
          approvalRequired: false,
          allowedByPolicy: false,
          policyProfile: project.execution.policy_profile,
          approvalRule: fileWriteApprovalRule ?? undefined
        },
        resultReceipt: {
          status: "rejected",
          artifactUri: rejectionArtifactUri,
          error: rejectionMessage
        }
      });
      if (isPatch && mutationRetriesRemaining > 0 && isRecoverableFileMutationFailure(rejectionMessage)) {
        mutationRetriesRemaining -= 1;
        await prepareRejectedPatchRetry({ path: fileWrite.path, cwd: localProjectRootUri, project, rejectionMessage, rejectedPatch: filePayload, rejectionArtifactUri, runId: task.runId, stageId: task.stageId, agentId: task.agentId, taskId: task.taskId, retriesRemaining: mutationRetriesRemaining, reads: stageFileReads, deltas: stageStateDeltas });
        await assertLeaseOwned();
        await assertStageGuard(false);
        const retryStartedAt = Date.now();
        const retry = await executeWithProviderFallback({
          providerId: route.providerId,
          stageInput: { ...routedStageInput, fileReads: stageFileReads, stateDeltas: stageStateDeltas },
          policy: { ...fallbackPolicy, chains: {}, maxRetries: 0 },
          providerFactory: guardedProviderFactory
        });
        await recordDirectProviderUsage({ stage: routedStageInput, attempts: retry.attempts, output: retry.output, latencyMs: Date.now() - retryStartedAt }).catch(() => 0);
        fallbackAttempts = [...fallbackAttempts, ...retry.attempts];
        output = retry.output;
        quality = scoreOutput(output);
        actualProviderId = retry.actualProvider;
        actualModel = retry.actualModel;
        const replacementWriteRequested = (output.requestedFileWrites ?? []).some((candidate) => candidate.path === fileWrite.path);
        if (output.outcome !== "blocked" && !replacementWriteRequested) {
          const supersededArtifactUri = await recordRunAction({
            runId: task.runId,
            taskId: task.taskId,
            agentId: task.agentId,
            actionType: "file_write_retry_superseded",
            target: fileWrite.path,
            summary: "The refreshed provider response no longer requested the rejected patch; the stale mutation was superseded without changing the file.",
            artifactKind: "file_write_retry",
            artifactContent: {
              rejectionArtifactUri,
              rejectionMessage,
              refreshedOutcome: output.outcome,
              requestedByTaskId: task.taskId,
              requestedByStageId: task.stageId
            }
          });
          actionResults.push({
            type: "file_write_retry_superseded",
            path: fileWrite.path,
            artifactUri: supersededArtifactUri,
            rejectionArtifactUri
          });
        }
        return result(true);
      }
      continue;
    }
    const summary = summarizeFileMutation(writeResult, isPatch);
    const artifactUri = await recordRunAction({
      runId: task.runId,
      taskId: task.taskId,
      agentId: task.agentId,
      actionType: "file_write",
      target: writeResult.relativePath,
      summary,
      artifactKind: "file_write",
      artifactContent: {
        ...writeResult,
        approvalRule: fileWriteApprovalRule ?? undefined,
        mode: isPatch ? "patch" : "replace",
        requestedByTaskId: task.taskId,
        requestedByStageId: task.stageId
      },
      idempotencyKey: fileWriteIdempotencyKey
    });
    const fileWriteFinalized = await finalizeSideEffect({ projectId: task.runId, idempotencyKey: fileWriteIdempotencyKey, claimToken: fileSideEffect.claimToken, receipt: { artifactUri, path: writeResult.relativePath, nextHash: writeResult.nextHash } });
    if (!fileWriteFinalized) throw new Error(`File-write side-effect claim could not be finalized for ${fileWrite.path}.`);
    await dismissSupersededActionApprovals({ runId: task.runId, taskId: task.taskId, actionType: "file_write", target: fileWrite.path, actor: task.workerId! });
    actionResults.push({
      type: "file_write",
      path: writeResult.relativePath,
      artifactUri,
      bytesWritten: writeResult.bytesWritten,
      previousHash: isPatch ? fileWrite.expectedHash : undefined,
      nextHash: writeResult.nextHash,
      approvalRule: fileWriteApprovalRule ?? undefined
    });
    await recordBoundedReactLoopReceipt({
      task,
      stagePattern,
      iteration: reactIteration,
      totalRequestedActions,
      actionType: "file_write",
      target: writeResult.relativePath,
      payloadHash: hashText(filePayload),
      policyDecision: {
        status: fileWriteApprovalRule ? "auto_approved_by_rule" : "allowed",
        approvalRequired: false,
        allowedByPolicy: true,
        policyProfile: project.execution.policy_profile,
        approvalRule: fileWriteApprovalRule ?? undefined
      },
      resultReceipt: {
        status: "completed",
        artifactUri,
        bytesWritten: writeResult.bytesWritten,
        previousHash: writeResult.previousHash,
        nextHash: writeResult.nextHash
      }
    });
  }
  return result(false);
}
