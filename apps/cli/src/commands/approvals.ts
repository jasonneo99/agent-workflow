import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { ApprovalBacklogReport, DashboardFollowUpResult } from "../lib/cli-types.js";
import { approvalRuleBroadTarget, approvalRuleExactTarget, buildApprovalBacklogReport, deliverRunNotifications, dismissApprovedAction, formatApprovalAutopilotResult, loadProjectApprovalRules, parseApprovalAutopilotRisk, processDashboardApprovalRuleAction, processRequesterApprovalReply, removeProjectApprovalRule, rolePreviewForApproval, runApprovalAutopilot } from "../lib/builders-approvals.js";
import { approveAndExecuteAction, evaluateRoleGate, executeApprovedAction, formatInlineCounts, isExecutableApprovalAction, loadApprovalProjectConfig, normalizeActorRole, shellQuote, stableHash } from "../lib/builders-shared.js";
import { loadAgentRecords, loadProjectConfig, loadWorkflowRecords, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { completeApprovalRequestRun, createWorkflowRun, decideActionApproval, getActionApproval, listActionApprovals, listPendingRunNotifications, requestActionApproval, seedRegistry } from "../../../../packages/storage/src/postgres.js";
import { parsePositiveInteger } from "../numeric-options.js";
import { normalizeLookup, resolveWorkflow } from "../reference-resolution.js";
import path from "node:path";

export function registerApprovalsCommands(program: Command, ctx: CliContext): void {
  function formatApprovalBacklogReport(report: ApprovalBacklogReport): string {
    const attentionItems = report.items.filter((item) => item.severity !== "info").slice(0, 25);
    return [
      "Approval backlog radar",
      `Project: ${report.projectRootUri ?? "all"}`,
      `Total: ${report.total}`,
      `Inspected: ${report.scanned}${report.truncated ? ` newest records (limit ${report.limit})` : " (all records)"}`,
      `Counts: ${formatInlineCounts(report.counts) || "none"}`,
      `Severity: info=${report.severityCounts.info ?? 0} warning=${report.severityCounts.warning ?? 0} error=${report.severityCounts.error ?? 0}`,
      "",
      attentionItems.length ? "Attention items:" : "No warning or error approval backlog items found.",
      ...attentionItems.map((item) => [
        `- ${item.severity} ${item.status}: ${item.actionType} ${item.target}`,
        `  id: ${item.approvalId}`,
        `  run: ${item.runId} ${item.workflowId}`,
        `  reason: ${item.reason}`,
        item.autopilotRisk ? `  autopilot: ${item.autopilotEligible ? "eligible" : "blocked"} / ${item.autopilotRisk}` : ""
      ].filter(Boolean).join("\n"))
    ].join("\n");
  }

  async function requestRunLevelApproval(input: {
    projectPath: string;
    type: string;
    target: string;
    rationale: string;
    workflowId?: string;
    policyProfile?: string;
    actor: string;
    actorRole?: string;
  }): Promise<DashboardFollowUpResult & { approvalId?: string }> {
    const approvalType = input.type.trim().toLowerCase();
    if (approvalType !== "deployment" && approvalType !== "autonomy") {
      return { ok: false, error: "--type must be deployment or autonomy" };
    }
    const target = input.target.trim();
    const rationale = input.rationale.trim();
    if (!target) {
      return { ok: false, error: "Approval target is required." };
    }
    if (!rationale) {
      return { ok: false, error: "Approval rationale is required." };
    }

    const projectDir = path.resolve(process.cwd(), input.projectPath);
    const configuredProject = await loadProjectConfig(projectDir);
    const requestRoleGate = evaluateRoleGate(configuredProject, input.actorRole ?? configuredProject.team.default_actor_role, "can_request_approvals");
    if (!requestRoleGate.allowed) {
      return { ok: false, error: requestRoleGate.message };
    }
    let resolvedPolicy: ReturnType<typeof resolveExecutionPolicy>;
    try {
      resolvedPolicy = resolveExecutionPolicy(configuredProject, input.policyProfile);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const workflows = await loadWorkflows(ctx.rootDir);
    const workflowId = input.workflowId ?? (approvalType === "deployment" ? "ship-release" : "wide-open-automation");
    const workflow = resolveWorkflow(workflows, workflowId);
    if (!workflow) {
      return { ok: false, error: `Unknown workflow: ${workflowId}` };
    }

    const agents = await loadAgentRecords(ctx.rootDir);
    const workflowRecords = await loadWorkflowRecords(ctx.rootDir);
    await seedRegistry(agents, workflowRecords);

    const actionType = approvalType === "deployment" ? "deployment" : "autonomy";
    const runTask = approvalType === "deployment"
      ? `Approval requested to deploy or release: ${target}`
      : `Approval requested for autonomy change: ${target}`;
    const payload = {
      requestType: approvalType,
      target,
      requestedBy: input.actor,
      requestedByRole: input.actorRole ?? null,
      policyProfile: resolvedPolicy.profile,
      projectAutonomy: String(resolvedPolicy.project.project.autonomy),
      workflowId: workflow.id,
      requestedAt: new Date().toISOString()
    };
    const idempotencyKey = stableHash({
      requestType: approvalType,
      projectDir,
      workflowId: workflow.id,
      target,
      rationale,
      policySnapshotHash: resolvedPolicy.snapshotHash
    });

    const run = await createWorkflowRun({
      projectName: resolvedPolicy.project.project.name,
      projectRootUri: projectDir,
      projectProfile: resolvedPolicy.project.project.autonomy === "wide-open" ? "enterprise" : "custom",
      projectConfig: configuredProject,
      workflow,
      task: runTask,
      autonomy: String(resolvedPolicy.project.project.autonomy),
      policyProfile: resolvedPolicy.profile,
      policySnapshot: resolvedPolicy.snapshot,
      policySnapshotHash: resolvedPolicy.snapshotHash,
      compiledBrief: [
        "# Approval Request",
        "",
        `Type: ${approvalType}`,
        `Target: ${target}`,
        `Project: ${resolvedPolicy.project.project.name}`,
        `Policy profile: ${resolvedPolicy.profile}`,
        `Policy snapshot: ${resolvedPolicy.snapshotHash}`,
        "",
        "## Rationale",
        rationale
      ].join("\n"),
      compiledBriefMetadata: {
        approvalRequest: payload
      }
    });

    const approval = await requestActionApproval({
      runId: run.runId,
      taskId: null,
      stageId: `${approvalType}-approval`,
      agentId: workflow.lead,
      actionType,
      target,
      rationale,
      policyDecision: {
        approvalRequired: true,
        requestType: approvalType,
        actorRole: input.actorRole ?? null,
        policyProfile: resolvedPolicy.profile,
        policySnapshotHash: resolvedPolicy.snapshotHash
      },
      payload,
      idempotencyKey
    });
    await completeApprovalRequestRun({
      runId: run.runId,
      agentId: workflow.lead,
      summary: `${approvalType} approval request queued for ${target}`,
      metadata: {
        ...payload,
        target,
        actorRole: input.actorRole ?? null,
        approvalId: approval.approvalId
      }
    });

    return {
      ok: true,
      title: "Approval request queued",
      runId: run.runId,
      approvalId: approval.approvalId,
      output: [
        `Approval: ${approval.approvalId}`,
        `Type: ${actionType}`,
        `Target: ${target}`,
        `Requester role: ${input.actorRole ?? "operator"}`,
        `Role gate: ${requestRoleGate.message}`,
        "Role preview: request expects operator; decision expects approver.",
        `Run: ${run.runId}`,
        `Workflow context: ${workflow.id}`,
        `Project: ${projectDir}`,
        "Open: /approvals"
      ].join("\n")
    };
  }

  program
    .command("approvals")
    .description("List, approve, approve-and-execute, reject, execute, dismiss, or add always rules for agent-requested actions")
    .option("--status <status>", "pending, approved, executed, failed, dismissed, rejected, or all", "pending")
    .option("-r, --run <id>", "filter by workflow run id")
    .option("-p, --project <dir>", "filter by project directory")
    .option("--approve <id>", "approval id to approve")
    .option("--approve-execute <id>", "approve an executable action and immediately execute it")
    .option("--reject <id>", "approval id to reject")
    .option("--execute <id>", "execute an approved action")
    .option("--dismiss <id>", "dismiss an approved action without execution")
    .option("--always <id>", "approval id to approve current request and add a future auto-execute rule")
    .option("--auto-approve-execute", "auto approve pending approvals and execute pending or already-approved executable actions at or below the configured risk threshold")
    .option("--max-risk <risk>", "max risk for --auto-approve-execute: low, medium, or high", process.env.AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK ?? "medium")
    .option("--dry-run", "preview --auto-approve-execute without changing approvals")
    .option("--always-scope <scope>", "rule scope for --always: exact, broad, or target", "exact")
    .option("--always-target <pattern>", "explicit stored target pattern when --always-scope target is used")
    .option("--actor <name>", "person or tool making the decision", "cli")
    .option("--actor-role <role>", "project role for audit receipts, such as operator, approver, workflow_author, or auditor")
    .option("--note <text>", "decision note")
    .option("-l, --limit <number>", "number of approvals to show", "25")
    .option("--json", "print JSON")
    .action(async (options: { status: string; run?: string; project?: string; approve?: string; approveExecute?: string; reject?: string; execute?: string; dismiss?: string; always?: string; autoApproveExecute?: boolean; maxRisk: string; dryRun?: boolean; alwaysScope: string; alwaysTarget?: string; actor: string; actorRole?: string; note?: string; limit: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      if ([options.approve, options.approveExecute, options.reject, options.execute, options.dismiss, options.always, options.autoApproveExecute ? "auto" : ""].filter(Boolean).length > 1) {
        console.error("Choose only one of --approve, --approve-execute, --reject, --execute, --dismiss, --always, or --auto-approve-execute.");
        process.exitCode = 1;
        return;
      }

      if (options.autoApproveExecute) {
        const result = await runApprovalAutopilot(ctx, {
          projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
          runId: options.run,
          limit: parsePositiveInteger(options.limit, 25),
          maxRisk: parseApprovalAutopilotRisk(options.maxRisk),
          execute: !options.dryRun,
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "approver")
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(formatApprovalAutopilotResult(result));
        if (result.items.some((item) => item.status === "failed")) process.exitCode = 1;
        return;
      }

      if (options.approveExecute) {
        const result = await approveAndExecuteAction(ctx, {
          approvalId: options.approveExecute,
          actor: options.actor,
          approveActorRole: normalizeActorRole(options.actorRole, "approver"),
          executeActorRole: "operator",
          note: options.note
        });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.title);
        console.log(result.output);
        return;
      }

      if (options.dismiss) {
        const result = await dismissApprovedAction(ctx, {
          approvalId: options.dismiss,
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "operator"),
          note: options.note
        });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.title);
        console.log(result.output);
        return;
      }

      if (options.execute) {
        const result = await executeApprovedAction(ctx, {
          approvalId: options.execute,
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "operator")
        });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.title);
        console.log(result.output);
        return;
      }

      if (options.always) {
        const approvalForRule = await getActionApproval(options.always);
        if (!approvalForRule) {
          console.error("Approval was not found or is no longer pending.");
          process.exitCode = 1;
          return;
        }
        if (approvalForRule.actionType !== "local_command" && approvalForRule.actionType !== "file_write" && approvalForRule.actionType !== "executor_adapter") {
          console.error("Always approve rules are only supported for shell, fswrite, and executor adapter approvals.");
          process.exitCode = 1;
          return;
        }
        const scope = normalizeLookup(options.alwaysScope || "exact");
        const target = scope === "exact"
          ? approvalRuleExactTarget(approvalForRule)
          : scope === "broad"
            ? approvalRuleBroadTarget(approvalForRule)
            : scope === "target" && options.alwaysTarget
              ? options.alwaysTarget.trim()
              : "";
        if (!target) {
          console.error("--always-scope must be exact, broad, or target with --always-target.");
          process.exitCode = 1;
          return;
        }
        const result = await processDashboardApprovalRuleAction(ctx, {
          approvalId: options.always,
          target,
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "approver"),
          note: options.note ?? "",
          approveCurrent: true
        });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.title);
        console.log(result.output);
        return;
      }

      if (options.approve || options.reject) {
        const approvalId = options.approve ?? options.reject ?? "";
        const approvalForGate = await getActionApproval(approvalId);
        if (!approvalForGate) {
          console.error("Approval was not found or is no longer pending.");
          process.exitCode = 1;
          return;
        }
        const project = await loadApprovalProjectConfig(ctx, approvalForGate);
        const actorRole = normalizeActorRole(options.actorRole, "approver");
        const gate = evaluateRoleGate(project, actorRole, options.approve ? "can_approve_actions" : "can_reject_actions");
        if (!gate.allowed) {
          console.error(gate.message);
          process.exitCode = 1;
          return;
        }
        const approval = await decideActionApproval({
          approvalId,
          decision: options.approve ? "approved" : "rejected",
          actor: options.actor,
          actorRole,
          note: options.note
        });
        if (!approval) {
          console.error("Approval was not found or is no longer pending.");
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(approval, null, 2));
          return;
        }
        console.log(`${approval.status}: ${approval.id}`);
        console.log(`${approval.actionType} ${approval.target}`);
        console.log(`Run: ${approval.runId}`);
        return;
      }

      const status = options.status === "all" ? undefined : options.status;
      const approvals = await listActionApprovals({
        status,
        runId: options.run,
        projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
        limit: parsePositiveInteger(options.limit, 25)
      });
      if (options.json) {
        console.log(JSON.stringify(approvals, null, 2));
        return;
      }
      if (!approvals.length) {
        console.log("No action approvals found.");
        return;
      }
      for (const approval of approvals) {
        console.log(`${approval.id} ${approval.status} ${approval.actionType} ${approval.target}`);
        console.log(`  Run: ${approval.runId} ${approval.workflowId}`);
        console.log(`  Stage: ${approval.stageId} (${approval.agentId})`);
        console.log(`  Project: ${approval.projectRootUri}`);
        console.log(`  Rationale: ${approval.rationale}`);
        console.log(`  Role preview: ${rolePreviewForApproval(approval)}`);
        if (approval.status === "pending") {
          console.log(`  Approve: npm run agentflow -- approvals --approve ${approval.id} --actor "Your Name" --actor-role approver`);
          if (isExecutableApprovalAction(approval.actionType)) {
            console.log(`  Approve + execute: npm run agentflow -- approvals --approve-execute ${approval.id} --actor "Your Name" --actor-role approver`);
          }
          if (approval.actionType === "local_command" || approval.actionType === "file_write" || approval.actionType === "executor_adapter") {
            console.log(`  Always exact: npm run agentflow -- approvals --always ${approval.id} --always-scope exact --actor "Your Name" --actor-role approver`);
            if (approval.actionType !== "executor_adapter") console.log(`  Always broad: npm run agentflow -- approvals --always ${approval.id} --always-scope broad --actor "Your Name" --actor-role approver`);
          }
        }
        if (approval.status === "approved" && isExecutableApprovalAction(approval.actionType)) {
          console.log(`  Execute: npm run agentflow -- approvals --execute ${approval.id} --actor "Your Name" --actor-role operator`);
          console.log(`  Dismiss stale: npm run agentflow -- approvals --dismiss ${approval.id} --actor "Your Name" --actor-role operator --note "Out of date"`);
        }
        if (approval.decidedBy) {
          console.log(`  Decided: ${approval.decidedBy}${approval.decidedRole ? ` (${approval.decidedRole})` : ""} at ${approval.decidedAt ?? "unknown"}${approval.decisionNote ? ` - ${approval.decisionNote}` : ""}`);
        }
      }
    });

  program
    .command("approval-rules")
    .description("List or remove project-local always-approved action rules")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--remove <id>", "approval rule id to remove")
    .option("--actor <name>", "person or tool making the change", "cli")
    .option("--json", "print JSON")
    .action(async (options: { project: string; remove?: string; actor: string; json?: boolean }) => {
      const projectRootUri = path.resolve(process.cwd(), options.project);
      if (options.remove) {
        const result = await removeProjectApprovalRule({
          projectRootUri,
          ruleId: options.remove,
          actor: options.actor
        });
        if (!result.ok) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.title);
        console.log(result.output);
        return;
      }

      const rules = await loadProjectApprovalRules(projectRootUri);
      if (options.json) {
        console.log(JSON.stringify(rules, null, 2));
        return;
      }
      if (!rules.length) {
        console.log("No always-approved action rules found.");
        return;
      }
      for (const rule of rules) {
        console.log(`${rule.id} ${rule.functionLabel}`);
        console.log(`  Project: ${rule.projectRootUri}`);
        console.log(`  Description: ${rule.description || "none"}`);
        console.log(`  Effect: ${rule.effect}${rule.maxBytes ? `, max_bytes=${rule.maxBytes}` : ""}`);
        console.log(`  Remove: npm run agentflow -- approval-rules --project ${shellQuote(rule.projectRootUri)} --remove ${rule.id}`);
      }
    });

  program
    .command("approval-backlog")
    .description("Surface pending, stale, warning, and failed approval items without changing them")
    .option("--status <status>", "pending, approved, executed, failed, dismissed, rejected, or all", "all")
    .option("-p, --project <dir>", "project directory filter")
    .option("--stale-minutes <number>", "age before pending or approved approvals are considered stale", "60")
    .option("-l, --limit <number>", "number of approvals to inspect", "500")
    .option("--json", "print JSON")
    .action(async (options: { status: string; project?: string; staleMinutes: string; limit: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const report = await buildApprovalBacklogReport(ctx, {
        status: options.status === "all" ? undefined : options.status,
        projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
        staleMinutes: parsePositiveInteger(options.staleMinutes, 60),
        limit: parsePositiveInteger(options.limit, 500)
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatApprovalBacklogReport(report));
      if ((report.severityCounts.error ?? 0) > 0) process.exitCode = 1;
    });

  program
    .command("request-approval")
    .description("Create a run-level approval request for deployment or autonomy decisions")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("--type <type>", "deployment or autonomy")
    .requiredOption("--target <target>", "approval target, such as staging, production, or autonomy level")
    .requiredOption("--rationale <text>", "why this approval is needed")
    .option("-w, --workflow <id>", "workflow context for the approval request")
    .option("--policy-profile <name>", "execution policy profile snapshot to attach")
    .option("--actor <name>", "person or tool requesting approval", "cli")
    .option("--actor-role <role>", "project role for audit receipts", "operator")
    .option("--json", "print JSON")
    .action(async (options: { project: string; type: string; target: string; rationale: string; workflow?: string; policyProfile?: string; actor: string; actorRole: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const result = await requestRunLevelApproval({
        projectPath: options.project,
        type: options.type,
        target: options.target,
        rationale: options.rationale,
        workflowId: options.workflow,
        policyProfile: options.policyProfile,
        actor: options.actor,
        actorRole: normalizeActorRole(options.actorRole, "operator")
      });
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.title);
      console.log(result.output);
    });

  program
    .command("notifications")
    .description("List requester notifications queued when runs block or need approval")
    .option("--pending", "only show undelivered notifications", true)
    .option("--deliver", "attempt delivery through each notification's channel now")
    .option("--notification <id>", "deliver only this exact notification once; requires --deliver and --project")
    .option("-p, --project <dir>", "project directory (used for codex channel delivery)")
    .action(async (options: { pending?: boolean; deliver?: boolean; project?: string; notification?: string }) => {
      if (options.notification !== undefined && (!options.deliver || !options.project
        || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(options.notification))) {
        throw new Error("Exact notification delivery requires a UUID, --deliver and --project.");
      }
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      if (options.notification) {
        const delivered = await deliverRunNotifications(path.resolve(process.cwd(), options.project!), options.notification);
        console.log(`Transport-delivered: ${delivered}; acknowledgment unverified. No unrelated notifications selected.`);
        return;
      }
      const pending = await listPendingRunNotifications(100);
      if (pending.length === 0) {
        console.log("No pending requester notifications.");
        return;
      }
      for (const notification of pending) {
        console.log(`- [${notification.kind}] ${notification.title}`);
        console.log(`  id: ${notification.id}  run: ${notification.runId}  to: ${notification.requester}  channel: ${notification.channel}`);
        console.log(`  ${notification.body.split("\n")[0]}`);
      }
      if (options.deliver === true) {
        const projectDir = options.project ? path.resolve(process.cwd(), options.project) : process.cwd();
        const delivered = await deliverRunNotifications(projectDir);
        console.log(`Delivered ${delivered}/${pending.length} notification(s).`);
      }
    });

  program
    .command("engine-events")
    .description("Private local NDJSON lifecycle stream; stdin ACK only after durable client receipt")
    .option("-p, --project <dir>", "optional project filter; default is all registered projects")
    .requiredOption("--consumer <id>", "stable private local client identity; independent acknowledgment state")
    .option("--task <id>", "restrict to one originating conversation")
    .action(async (options: { project?: string; consumer: string; task?: string }) => {
      const { runOriginEventStream } = await import("../origin-event-stream.js");
      await runOriginEventStream({ ...options, project: options.project ? path.resolve(options.project) : undefined });
    });

  program
    .command("notification-consumer")
    .description("Consume one exact outbox notification through an explicitly configured signed webhook")
    .requiredOption("-p, --project <dir>", "authorized project directory")
    .requiredOption("--notification <id>", "exact notification UUID")
    .requiredOption("--channel <channel>", "authorized notification channel")
    .requiredOption("--task <id>", "authenticated destination task binding")
    .requiredOption("--endpoint <url>", "administrator-approved webhook endpoint")
    .option("--subscriber <id>", "use independent delivery state for this registered subscriber")
    .option("--secret-env <name>", "environment variable holding the signing secret", "AGENTFLOW_WEBHOOK_SECRET")
    .option("--checks <count>", "maximum eligibility checks (1-100)", "30")
    .option("--interval-ms <milliseconds>", "time between eligibility checks", "2000")
    .option("--loopback-test", "allow HTTP to numeric loopback for an isolated test")
    .action(async (options: { project: string; notification: string; channel: string; task: string; endpoint: string; subscriber?: string; secretEnv: string; checks: string; intervalMs: string; loopbackTest?: boolean }) => {
      const { createWebhookHost, consumeHostNotification } = await import("../notification-webhook.js");
      const { claimRunNotifications, settleRunNotification } = await import("../../../../packages/storage/src/run-notifications.js");
      const { claimSubscriberNotification, settleSubscriberNotification } = await import("../../../../packages/storage/src/notification-subscribers.js");
      const projectRootUri = path.resolve(process.cwd(), options.project);
      const host = createWebhookHost({ projectRootUri, channel: options.channel, taskId: options.task,
        endpoint: options.endpoint, secret: process.env[options.secretEnv] ?? "", allowLoopbackHttp: options.loopbackTest === true });
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        const result = await consumeHostNotification({ projectRootUri, owner: `webhook-consumer:${process.pid}`,
          notificationId: options.notification, maxChecks: Number(options.checks), intervalMs: Number(options.intervalMs),
          signal: controller.signal }, host, options.subscriber ? {
          claim: input => claimSubscriberNotification({ ...input, notificationId: options.notification, subscriberId: options.subscriber! }),
          settle: input => settleSubscriberNotification({ ...input, subscriberId: options.subscriber! })
        } : { claim: claimRunNotifications, settle: settleRunNotification });
        console.log(JSON.stringify(result));
        if (!result.transportDelivered) process.exitCode = 1;
      } finally {
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
      }
    });

  program
    .command("reply")
    .description("Answer a pending approval the way you would in chat: reply <approval-id> approve|reject")
    .argument("<approval-id>", "approval id from the notification or approvals list")
    .argument("<decision>", "approve or reject")
    .option("--actor <name>", "person or tool making the decision", process.env.AGENTFLOW_REQUESTER ?? process.env.USER ?? "cli")
    .option("--note <text>", "optional note recorded with the decision")
    .action(async (approvalId: string, decision: string, options: { actor: string; note?: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const result = await processRequesterApprovalReply({ approvalId, decision, actor: options.actor, note: options.note });
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(result.output);
    });

}
