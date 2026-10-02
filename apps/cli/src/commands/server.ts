import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { ServerApprovalActionPlanReport, ServerApprovalActionReport, ServerApprovalActionTestAdapterReport, ServerApprovalPreviewReport, ServerMutationControlReport, ServerProjectRegistryReport, ServerProjectResolution, ServerReadinessReport, ServerRequestAuditReport, ServerRequestPreviewReport, ServerRoutePreviewReport } from "../lib/cli-types.js";
import { buildServerApprovalActionPlanReport, buildServerApprovalActionTestAdapterReport, buildServerMutationControlReport, loadServerApprovalActionReport, loadServerApprovalPreview, loadServerProjectRegistryReport, loadServerReadinessReport, loadServerRequestAuditLog, loadServerRequestPreview, loadServerRoutePreview, processSynchronousConversation, resolveServerProjectReference } from "../lib/builders-server.js";
import { formatInlineCounts } from "../lib/builders-shared.js";
import { formatServerConversationReport } from "../dashboard/question-chat.js";
import { parsePositiveInteger } from "../numeric-options.js";
import path from "node:path";

export function registerServerCommands(program: Command, ctx: CliContext): void {
  function formatServerApprovalActionPlanReport(report: ServerApprovalActionPlanReport): string {
    return [
      `Server approval action plan (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Can enable approval actions: ${report.canEnableApprovalActions ? "yes" : "no"}`,
      "",
      "Summary:",
      `- decisions: ${report.summary.decisions}`,
      `- ready: ${report.summary.ready}`,
      `- blocked: ${report.summary.blocked}`,
      `- receipt plan ready: ${report.summary.receiptPlanReady}`,
      `- idempotency reuse ready: ${report.summary.idempotencyReuseReady}`,
      `- rollback evidence ready: ${report.summary.rollbackEvidenceReady}`,
      "",
      "Decisions:",
      ...report.decisions.map((decision) => `- ${decision.status.toUpperCase()} ${decision.decision}: receipts=${decision.requiredReceiptKinds.join(", ")}; mutates=${decision.mutatesApprovalState}; executes=${decision.executesSideEffect}; missing=${decision.missingControls.join(", ") || "none"}`),
      "",
      "Implementation phases:",
      ...report.implementationPhases.map((phase) => `- ${phase.status.toUpperCase()} ${phase.phase}: ${phase.detail}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerApprovalActionReport(report: ServerApprovalActionReport): string {
    return [
      `Server approval action endpoint (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Dry run: ${report.dryRun ? "yes" : "no"}`,
      "",
      "Envelope:",
      `- requestId: ${report.envelope.requestId}`,
      `- projectId: ${report.envelope.projectId}`,
      `- approvalId: ${report.envelope.approvalId}`,
      `- decision: ${report.envelope.decision}`,
      `- actorRole: ${report.envelope.actorRole}`,
      `- idempotencyKey: ${report.envelope.idempotencyKey}`,
      "",
      "Controls:",
      `- serverModeEnabled: ${report.controls.serverModeEnabled}`,
      `- approvalActionExecutionEnabled: ${report.controls.approvalActionExecutionEnabled}`,
      `- clientProvidedIdempotency: ${report.controls.clientProvidedIdempotency}`,
      `- perActionReceiptGate: ${report.controls.perActionReceiptGate}`,
      `- wouldMutate: ${report.controls.wouldMutate}`,
      ...(report.mutation ? [
        `- replayed: ${report.mutation.replayed}`,
        `- outcome: ${report.mutation.outcome}`,
        `- receipt: ${report.mutation.receiptUri}`,
        `- beforeStatus: ${report.mutation.beforeStatus ?? "unknown"}`,
        `- afterStatus: ${report.mutation.afterStatus ?? "unknown"}`
      ] : []),
      "",
      "Checks:",
      ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerApprovalActionTestAdapterReport(report: ServerApprovalActionTestAdapterReport): string {
    return [
      `Server approval action test adapter (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Dry run: ${report.dryRun ? "yes" : "no"}`,
      `Live side effects: ${report.liveSideEffects ? "yes" : "no"}`,
      "",
      "Summary:",
      `- decisions: ${report.summary.decisions}`,
      `- passed: ${report.summary.passed}`,
      `- failed: ${report.summary.failed}`,
      `- replayed: ${report.summary.replayed}`,
      `- simulated side effects: ${report.summary.simulatedSideEffects}`,
      "",
      "Decisions:",
      ...report.decisions.map((decision) => `- ${decision.status.toUpperCase()} ${decision.decision}: receipts=${decision.firstReceiptKinds.join(", ")}; replayMatched=${decision.replayMatched}; sideEffects=${decision.sideEffectExecutions}${decision.errors.length ? `; errors=${decision.errors.join(", ")}` : ""}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerApprovalPreview(report: ServerApprovalPreviewReport): string {
    return [
      `Server approval preview (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Dry run: ${report.dryRun ? "yes" : "no"}`,
      "",
      "Envelope:",
      `- requestId: ${report.envelope.requestId}`,
      `- projectId: ${report.envelope.projectId}`,
      `- approvalId: ${report.envelope.approvalId}`,
      `- decision: ${report.envelope.decision}`,
      `- actorRole: ${report.envelope.actorRole}`,
      `- idempotencyKey: ${report.envelope.idempotencyKey}`,
      "",
      "Approval:",
      ...(report.approval ? [
        `- run: ${report.approval.runId}`,
        `- workflow: ${report.approval.workflowId}`,
        `- stage: ${report.approval.stageId} (${report.approval.agentId})`,
        `- status: ${report.approval.status}`,
        `- action: ${report.approval.actionType} ${report.approval.target}`,
        `- projectRootHash: ${report.approval.projectRootHash}`
      ] : ["- No approval resolved."]),
      "",
      "Checks:",
      ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerMutationControlReport(report: ServerMutationControlReport): string {
    return [
      `Server mutation controls (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Mode: server=${report.mode.serverModeEnabled ? "enabled" : "disabled"}, bind=${report.mode.bind}${report.mode.networkExposed ? " network-exposed" : " loopback"}, auth=${report.mode.authMode}, queueGate=${report.mode.queueExecutionEnabled ? "on" : "off"}, approvalActionGate=${report.mode.approvalActionExecutionEnabled ? "on" : "off"}, bodyLimit=${report.mode.requestBodyMaxBytes} bytes, rateLimit=${report.mode.rateLimitPerMinute <= 0 ? "off" : `${report.mode.rateLimitPerMinute}/min`}`,
      "",
      "Summary:",
      `- endpoints: ${report.summary.endpoints}`,
      `- remote mutation endpoints: ${report.summary.remoteMutationEndpoints}`,
      `- ready remote mutations: ${report.summary.readyRemoteMutations}`,
      `- blocked remote mutations: ${report.summary.blockedRemoteMutations}`,
      `- local-only mutations: ${report.summary.localOnlyMutations}`,
      "",
      "Endpoints:",
      ...report.endpoints.map((endpoint) => `- ${endpoint.status.toUpperCase()} ${endpoint.method} ${endpoint.path}: ${endpoint.name} (${endpoint.exposure}); missing=${endpoint.missingControls.join(", ") || "none"}; gate=${endpoint.executionGate}`),
      "",
      "Recommended actions:",
      ...report.recommendedActions.map((action) => `- ${action}`)
    ].join("\n");
  }

  function formatServerProjectRegistryReport(report: ServerProjectRegistryReport): string {
    return [
      `Server project registry (${report.generatedAt})`,
      `Project filter: ${report.projectRootUri ?? "all registered projects"}`,
      `Roots included: ${report.includeRoots ? "yes" : "no"}`,
      "",
      "Checks:",
      ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Projects:",
      ...(report.projects.length ? report.projects.map((project) => [
        `- ${project.name} (${project.projectId})`,
        `  root: ${project.rootUri ?? `redacted; hash=${project.rootHash.slice(0, 12)}`}`,
        `  config: ${project.configStatus}, policy=${project.policyProfile}, roles=${project.roleEnforcement}`,
        `  workflows: ${project.defaultWorkflows.join(", ") || "none configured"}`,
        `  request: ${JSON.stringify(project.requestExample)}`
      ].join("\n")) : ["- No registered projects found."]),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerProjectResolution(result: ServerProjectResolution): string {
    if (!result.resolved || !result.project) {
      return [
        `Server project resolution (${result.generatedAt})`,
        `Project id: ${result.projectId}`,
        "Resolved: no",
        `Reason: ${result.reason ?? "unknown"}`,
        "",
        "Checks:",
        ...result.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`)
      ].join("\n");
    }
    return [
      `Server project resolution (${result.generatedAt})`,
      `Project id: ${result.projectId}`,
      "Resolved: yes",
      `Name: ${result.project.name}`,
      `Root: ${result.project.rootUri ?? `redacted; hash=${result.project.rootHash.slice(0, 12)}`}`,
      `Config: ${result.project.configStatus}`,
      `Policy profile: ${result.project.policyProfile}`,
      `Role enforcement: ${result.project.roleEnforcement}`,
      `Default workflows: ${result.project.defaultWorkflows.join(", ") || "none configured"}`,
      "",
      "Checks:",
      ...result.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`)
    ].join("\n");
  }

  function formatServerReadinessReport(report: ServerReadinessReport): string {
    return [
      `Server mode readiness (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Project: ${report.projectRootUri ?? "all registered projects"}`,
      "",
      "Mode:",
      `- Enabled: ${report.mode.enabled ? "yes" : "no"}`,
      `- Bind: ${report.mode.bind}:${report.mode.port}${report.mode.networkExposed ? " (network-exposed)" : " (loopback/local)"}`,
      `- Auth: ${report.mode.authMode}`,
      `- Token configured: ${report.mode.tokenConfigured ? "yes" : "no"}`,
      `- Allowed origins: ${report.mode.allowedOrigins.join(", ") || "none"}`,
      "",
      "Checks:",
      ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Auth hardening:",
      `- Status: ${report.authHardening.status}`,
      `- Summary: ${report.authHardening.summary}`,
      ...report.authHardening.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Projects:",
      ...(report.projects.length ? report.projects.map((project) => `- ${project.name} (${project.id}): ${project.configStatus}, roles=${project.roles.join(", ") || "none"}, enforcement=${project.roleEnforcement}, separation=${project.separationOfDuties}`) : ["- No registered projects inspected."]),
      "",
      "Endpoint classes:",
      ...report.endpointClasses.map((endpoint) => `- ${endpoint.name}: ${endpoint.exposure}, implemented=${endpoint.implemented ? "yes" : "no"}, ready=${endpoint.ready ? "yes" : "no"} (${endpoint.requiredControls.join("; ")})`),
      "",
      "Recommended commands:",
      ...report.recommendedCommands.map((command) => `- ${command}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerRequestAuditReport(report: ServerRequestAuditReport): string {
    return [
      `Server request audit log (${report.generatedAt})`,
      `Path: ${report.logPath}`,
      `Events: ${report.totalRead}`,
      `Latest: ${report.latestAt ?? "none"}`,
      `Invalid lines skipped: ${report.invalidLines}`,
      "",
      "Summary:",
      `- queued: ${report.queued}`,
      `- blocked/rejected: ${report.blocked}`,
      `- dry runs: ${report.dryRuns}`,
      `- rate limited: ${report.rateLimited}`,
      `- status counts: ${formatInlineCounts(report.statusCounts) || "none"}`,
      `- auth counts: ${formatInlineCounts(report.authCounts) || "none"}`,
      "",
      "Recent events:",
      ...(report.events.length ? report.events.map((event) => `- ${event.generatedAt} ${event.status.toUpperCase()} ${event.method} ${event.path} project=${event.projectId ?? "n/a"} workflow=${event.workflowId ?? "n/a"} execute=${event.executeRequested ? "yes" : "no"} auth=${event.auth.method}:${event.auth.accepted ? "pass" : event.auth.errorCode ?? "fail"} rateLimit=${event.rateLimit.accepted === null ? "n/a" : event.rateLimit.accepted ? "pass" : "fail"} run=${event.queuedRunId ?? "none"}`) : ["- No server request audit events found."]),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerRequestPreview(report: ServerRequestPreviewReport): string {
    return [
      `Server request preview (${report.generatedAt})`,
      `Status: ${report.status}`,
      "",
      "Envelope:",
      `- requestId: ${report.envelope.requestId}`,
      `- idempotencyKey: ${report.envelope.idempotencyKey}`,
      `- actor: ${report.envelope.actor}`,
      `- actorRole: ${report.envelope.actorRole}`,
      `- projectId: ${report.envelope.projectId}`,
      `- workflow: ${report.envelope.workflow}`,
      `- task: ${report.envelope.task}`,
      `- policyProfile: ${report.envelope.policyProfile ?? "unknown"}`,
      `- wouldQueue: ${report.controls.wouldQueue ? "yes" : "no"}`,
      "",
      "Checks:",
      ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatServerRoutePreview(report: ServerRoutePreviewReport): string {
    return [
      `Server route preview (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Dry run: ${report.dryRun ? "yes" : "no"}`,
      "",
      "Envelope:",
      `- projectId: ${report.envelope.projectId}`,
      `- workflow: ${report.envelope.workflow}`,
      `- actorRole: ${report.envelope.actorRole}`,
      `- idempotencyKey: ${report.envelope.idempotencyKey}`,
      "",
      "Route:",
      ...(report.route ? [
        `- project: ${report.route.projectName}`,
        `- root: ${report.route.projectRootUri}`,
        `- workflow: ${report.route.workflowId}`,
        `- policyProfile: ${report.route.policyProfile}`,
        `- commandPreview: ${report.route.commandPreview}`
      ] : ["- No route produced."]),
      "",
      "Checks:",
      ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  program
    .command("server-readiness")
    .description("Inspect read-only governed server-mode readiness without enabling remote execution")
    .option("-p, --project <dir>", "filter by project directory")
    .option("-l, --limit <number>", "number of registered projects to inspect", "100")
    .option("--json", "print machine-readable server readiness report")
    .action(async (options: { project?: string; limit: string; json?: boolean }) => {
      const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
      const report = await loadServerReadinessReport({
        projectRootUri,
        limit: parsePositiveInteger(options.limit, 100)
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerReadinessReport(report));
    });

  program
    .command("server-mutation-controls")
    .description("Audit governed server-mode mutation endpoint controls without enabling remote execution")
    .option("--json", "print machine-readable mutation control report")
    .action(async (options: { json?: boolean }) => {
      const report = buildServerMutationControlReport();
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerMutationControlReport(report));
      if (report.status === "blocked") process.exitCode = 2;
    });

  program
    .command("server-approval-action-plan")
    .description("Inspect the per-decision receipt and idempotency plan required before remote approval/action mutation")
    .option("--json", "print machine-readable approval/action execution plan")
    .action(async (options: { json?: boolean }) => {
      const report = buildServerApprovalActionPlanReport();
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerApprovalActionPlanReport(report));
    });

  program
    .command("server-approval-action-test-adapter")
    .description("Exercise the remote approval/action mutation contract against an in-memory local test adapter with no live side effects")
    .option("--json", "print machine-readable test-adapter proof")
    .action(async (options: { json?: boolean }) => {
      const report = buildServerApprovalActionTestAdapterReport();
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerApprovalActionTestAdapterReport(report));
      if (report.status !== "pass") process.exitCode = 1;
    });

  program
    .command("server-request-log")
    .description("Inspect redacted governed server-mode request audit events")
    .option("-l, --limit <number>", "number of recent audit events to show", "50")
    .option("--json", "print machine-readable request audit log")
    .action(async (options: { limit: string; json?: boolean }) => {
      const report = await loadServerRequestAuditLog(ctx, parsePositiveInteger(options.limit, 50));
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerRequestAuditReport(report));
    });

  program
    .command("server-conversation")
    .description("Run one bounded local synchronous conversation through governed provider fallback")
    .requiredOption("--request-json <json>", "bounded conversation request JSON")
    .option("--json", "print machine-readable conversation result")
    .action(async (options: { requestJson: string; json?: boolean }) => {
      try {
        const result = await processSynchronousConversation(ctx, JSON.parse(options.requestJson) as unknown);
        console.log(options.json ? JSON.stringify(result, null, 2) : formatServerConversationReport(result));
        if (result.status === "blocked") process.exitCode = 2;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });

  program
    .command("server-projects")
    .description("Preview registered project ids for governed server-mode clients without accepting arbitrary paths")
    .option("-p, --project <dir>", "filter by local project directory")
    .option("-l, --limit <number>", "number of registered projects to inspect", "100")
    .option("--include-roots", "include local filesystem roots for operator diagnostics")
    .option("--json", "print machine-readable registered project report")
    .action(async (options: { project?: string; limit: string; includeRoots?: boolean; json?: boolean }) => {
      const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
      const report = await loadServerProjectRegistryReport({
        projectRootUri,
        limit: parsePositiveInteger(options.limit, 100),
        includeRoots: Boolean(options.includeRoots)
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerProjectRegistryReport(report));
    });

  program
    .command("server-resolve-project")
    .description("Resolve one registered project id for governed server-mode routing without accepting filesystem paths")
    .requiredOption("--project-id <id>", "registered project id from server-projects")
    .option("--include-root", "include the local filesystem root for operator diagnostics")
    .option("--json", "print machine-readable project resolution")
    .action(async (options: { projectId: string; includeRoot?: boolean; json?: boolean }) => {
      const result = await resolveServerProjectReference({
        projectId: options.projectId,
        includeRoot: Boolean(options.includeRoot)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatServerProjectResolution(result));
      if (!result.resolved) process.exitCode = 2;
    });

  program
    .command("server-request-preview")
    .description("Preview a governed server-mode workflow request envelope without queueing work")
    .requiredOption("--project-id <id>", "registered project id from server-projects")
    .requiredOption("-w, --workflow <id>", "workflow id to request")
    .requiredOption("-t, --task <text>", "natural-language task")
    .option("--actor <name>", "requesting actor", "local-preview")
    .option("--actor-role <role>", "project role for the request", "operator")
    .option("--idempotency-key <key>", "client-provided idempotency key")
    .option("--json", "print machine-readable request preview")
    .action(async (options: { projectId: string; workflow: string; task: string; actor: string; actorRole: string; idempotencyKey?: string; json?: boolean }) => {
      const report = await loadServerRequestPreview(ctx, {
        projectId: options.projectId,
        workflowId: options.workflow,
        task: options.task,
        actor: options.actor,
        actorRole: options.actorRole,
        idempotencyKey: options.idempotencyKey
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerRequestPreview(report));
      if (report.status === "blocked") process.exitCode = 2;
    });

  program
    .command("server-route-preview")
    .description("Resolve a governed server-mode workflow request into an internal route without queueing work")
    .requiredOption("--project-id <id>", "registered project id from server-projects")
    .requiredOption("-w, --workflow <id>", "workflow id to request")
    .requiredOption("-t, --task <text>", "natural-language task")
    .option("--actor <name>", "requesting actor", "local-preview")
    .option("--actor-role <role>", "project role for the request", "operator")
    .option("--idempotency-key <key>", "client-provided idempotency key")
    .option("--json", "print machine-readable route preview")
    .action(async (options: { projectId: string; workflow: string; task: string; actor: string; actorRole: string; idempotencyKey?: string; json?: boolean }) => {
      const report = await loadServerRoutePreview(ctx, {
        projectId: options.projectId,
        workflowId: options.workflow,
        task: options.task,
        actor: options.actor,
        actorRole: options.actorRole,
        idempotencyKey: options.idempotencyKey
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerRoutePreview(report));
      if (report.status === "blocked") process.exitCode = 2;
    });

  program
    .command("server-approval-preview")
    .description("Preview a governed server-mode approval/action envelope without deciding or executing it")
    .requiredOption("--project-id <id>", "registered project id from server-projects")
    .requiredOption("--approval-id <id>", "approval id to preview")
    .option("--decision <decision>", "approve, reject, execute, approve-and-execute, dismiss, or always-approve", "approve-and-execute")
    .option("--actor <name>", "requesting actor", "local-preview")
    .option("--actor-role <role>", "project role for the approval/action request", "approver")
    .option("--idempotency-key <key>", "client-provided idempotency key")
    .option("--json", "print machine-readable approval/action preview")
    .action(async (options: { projectId: string; approvalId: string; decision: string; actor: string; actorRole: string; idempotencyKey?: string; json?: boolean }) => {
      const report = await loadServerApprovalPreview(ctx, {
        projectId: options.projectId,
        approvalId: options.approvalId,
        decision: options.decision,
        actor: options.actor,
        actorRole: options.actorRole,
        idempotencyKey: options.idempotencyKey
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerApprovalPreview(report));
      if (report.status === "blocked") process.exitCode = 2;
    });

  program
    .command("server-approval-action")
    .description("Validate the governed server-mode approval/action endpoint contract without mutating approval state")
    .requiredOption("--project-id <id>", "registered project id from server-projects")
    .requiredOption("--approval-id <id>", "approval id to validate")
    .option("--decision <decision>", "approve, reject, execute, approve-and-execute, dismiss, or always-approve", "approve-and-execute")
    .option("--actor <name>", "requesting actor", "local-preview")
    .option("--actor-role <role>", "project role for the approval/action request", "approver")
    .option("--idempotency-key <key>", "client-provided idempotency key")
    .option("--json", "print machine-readable approval/action endpoint report")
    .action(async (options: { projectId: string; approvalId: string; decision: string; actor: string; actorRole: string; idempotencyKey?: string; json?: boolean }) => {
      const report = await loadServerApprovalActionReport(ctx, {
        projectId: options.projectId,
        approvalId: options.approvalId,
        decision: options.decision,
        actor: options.actor,
        actorRole: options.actorRole,
        idempotencyKey: options.idempotencyKey
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServerApprovalActionReport(report));
      if (report.status === "blocked") process.exitCode = 2;
    });

}
