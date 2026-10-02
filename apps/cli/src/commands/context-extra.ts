import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import { hasApprovedContextHoldout, loadContextOperatorReport } from "../lib/builders-context.js";
import { loadContextRoutingPolicy } from "../lib/builders-shared.js";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { inferContextLanguage, resolveSegmentedThresholdPolicy } from "../../../../packages/context-calibration/src/index.js";
import { type ContextIntent, type ContextRoutingPolicy, ProjectContextCache, assertContextProjectPath, buildShadowObservation, contextCacheKey, contextHoldoutCasesSchema, contextRoutingPolicySchema, decideContextRoute, delegateContextSummary, enforceContextDecision, evaluateContextHoldouts, sha256 as contextSha256, writeShadowObservationBatch } from "../../../../packages/context-gateway/src/index.js";
import { type ContextHost, formatHostDecision, hostHookDefinition, mergeHostHookConfig, normalizeHostRead } from "../../../../packages/context-host-adapters/src/index.js";
import { createCodegenPlan, finishCodegenPlan, readCodegenPlan } from "../../../../packages/governed-codegen/src/index.js";
import { executeAllowedCommand } from "../../../../packages/local-tools/src/command-executor.js";
import { assertFileWriteAllowed, executeAllowedFileWrite } from "../../../../packages/local-tools/src/file-writer.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { resolveContainedProjectPath } from "../../../../packages/roadmap-planner/src/index.js";
import { upsertProject } from "../../../../packages/storage/src/postgres.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export function registerContextExtraCommands(program: Command, ctx: CliContext): void {
  function parseContextHost(value: string): ContextHost {
    if (value === "claude" || value === "cursor" || value === "codex") return value;
    throw new Error("Context host must be claude, cursor, or codex.");
  }

  function parseContextIntent(value: string): ContextIntent {
    const normalized = value.trim().toLowerCase().replaceAll("-", "_");
    const allowed: ContextIntent[] = ["discovery", "summarization", "documentation", "test_inventory", "editing", "debugging", "concurrency", "security", "authorization", "migration", "public_api", "architecture", "safety_critical", "unknown"];
    if (!allowed.includes(normalized as ContextIntent)) throw new Error(`Unknown context intent ${value}. Allowed: ${allowed.join(", ")}`);
    return normalized as ContextIntent;
  }

  async function readStandardInput(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString("utf8").trim();
    if (!value) throw new Error("Hook input JSON is required on stdin.");
    return value;
  }

  async function writeContextHoldoutEvidence(input: {
    projectDir: string;
    casesHash: string;
    report: ReturnType<typeof evaluateContextHoldouts>;
  }): Promise<string> {
    const directory = path.join(input.projectDir, ".agent-workflow", "context-gateway", "holdout");
    await assertContextProjectPath(input.projectDir, directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, "latest.json");
    await fs.writeFile(target, `${JSON.stringify({ version: 1, evaluatedAt: new Date().toISOString(), casesHash: input.casesHash, ...input.report, caseBodiesStored: false }, null, 2)}\n`, { mode: 0o600 });
    return target;
  }

  async function writeContextRouteReceipt(input: {
    projectDir: string;
    projectId: string;
    file: string;
    intent: ContextIntent;
    decision: ReturnType<typeof decideContextRoute>;
    enforcement: ReturnType<typeof enforceContextDecision>;
    executed: boolean;
    cacheStatus: string;
    contentHash: string;
  }): Promise<string> {
    const directory = path.join(input.projectDir, ".agent-workflow", "context-gateway", "receipts");
    await assertContextProjectPath(input.projectDir, directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.json`);
    await fs.writeFile(target, `${JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      projectId: input.projectId,
      sourcePathHash: contextSha256(input.file),
      contentHash: input.contentHash,
      intent: input.intent,
      decision: input.decision,
      enforcement: input.enforcement,
      executed: input.executed,
      cacheStatus: input.cacheStatus,
      fileBodyStored: false
    }, null, 2)}\n`, { mode: 0o600 });
    return target;
  }

  program
    .command("context-route")
    .description("Preview or execute an evidence-gated routed context read")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("--file <path>", "project-relative source file")
    .requiredOption("--question <text>", "question to answer from the source")
    .option("--intent <intent>", "routing intent", "discovery")
    .option("--mode <mode>", "shadow, advisory, or enforce")
    .option("--holdout-approved", "confirm reviewed passing holdout evidence")
    .option("--exact", "use the explicit exact-read escape hatch")
    .option("--execute", "invoke the selected provider when routing redirects")
    .option("--json", "print JSON")
    .action(async (options: { project: string; file: string; question: string; intent: string; mode?: string; holdoutApproved?: boolean; exact?: boolean; execute?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const project = await loadProjectConfig(projectDir);
      const projectId = await upsertProject({ name: project.project.name, rootUri: projectDir, profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom", config: project });
      const sourcePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: options.file, label: "context source" });
      const content = await fs.readFile(sourcePath, "utf8");
      const basePolicy = await loadContextRoutingPolicy(ctx, projectDir);
      const mode = options.mode && ["shadow", "advisory", "enforce"].includes(options.mode) ? options.mode as ContextRoutingPolicy["mode"] : basePolicy.mode;
      const intent = parseContextIntent(options.intent);
      const providerId = process.env.DEFAULT_MODEL_PROVIDER?.trim().toLowerCase() || "mock";
      const extension = path.extname(options.file).toLowerCase().replace(/^\./u, "") || "none";
      const segmentedPolicy = await resolveSegmentedThresholdPolicy({ projectRoot: projectDir, policy: basePolicy, segment: { language: inferContextLanguage(options.file), fileType: extension, stage: "context-route", model: providerId } });
      const policy = contextRoutingPolicySchema.parse({ ...segmentedPolicy.policy, mode });
      const decision = decideContextRoute({ policy, intent, content, question: options.question });
      const holdoutEvidenceApproved = await hasApprovedContextHoldout(projectDir);
      let enforcement = enforceContextDecision({ policy, decision, exactReadRequested: Boolean(options.exact), holdoutApproved: Boolean(options.holdoutApproved) && holdoutEvidenceApproved });
      let routed: Awaited<ReturnType<typeof delegateContextSummary>> | null = null;
      let cacheStatus: "not-used" | "hit" | "miss" = "not-used";
      let cachePath: string | null = null;
      if (options.execute && enforcement.action === "redirect") {
        const provider = providerFromEnv();
        if (!provider.summarizeFile) throw new Error(`Provider ${provider.id} does not support file summarization.`);
        const policyHash = contextSha256(JSON.stringify(policy));
        const key = contextCacheKey({ contentHash: contextSha256(content), questionClass: intent, processorVersion: "1", model: provider.id, outputSchema: "claims-v1", policyHash });
        const cache = new ProjectContextCache(projectDir, projectId);
        const cached = await cache.get(key);
        if (cached) {
          cacheStatus = "hit";
          routed = { summary: cached.summary, claims: cached.claims, exactSlices: [] };
        } else {
          cacheStatus = "miss";
          routed = await delegateContextSummary({ sourcePath: path.relative(projectDir, sourcePath), content, question: options.question, model: provider.id, summarize: (request) => provider.summarizeFile!(request) });
          cachePath = await cache.put({ version: 1, projectId, key, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + policy.summary_cache_ttl_seconds * 1000).toISOString(), contentHash: contextSha256(content), policyHash, processorVersion: "1", model: provider.id, outputSchema: "claims-v1", summary: routed.summary, claims: routed.claims });
        }
        const minimumConfidence = routed.claims.length ? Math.min(...routed.claims.map((claim) => claim.confidence)) : 0;
        enforcement = enforceContextDecision({ policy, decision, confidence: minimumConfidence, exactReadRequested: Boolean(options.exact), holdoutApproved: Boolean(options.holdoutApproved) && holdoutEvidenceApproved });
      }
      const receipt = await writeContextRouteReceipt({ projectDir, projectId, file: options.file, intent, decision, enforcement, executed: Boolean(routed), cacheStatus, contentHash: contextSha256(content) });
      const report = { projectId, fileHash: contextSha256(options.file), contentHash: contextSha256(content), intent, decision, enforcement, thresholdProposalId: segmentedPolicy.proposalId, holdoutEvidenceApproved, executed: Boolean(routed), cacheStatus, cachePath: cachePath ? path.relative(projectDir, cachePath) : null, receipt: path.relative(projectDir, receipt), routed };
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log([`Context route: ${decision.route} (${decision.risk} risk)`, `Policy action: ${enforcement.action} — ${enforcement.reason}`, `Executed: ${routed ? "yes" : "no"}; cache: ${cacheStatus}`, routed ? `Summary:\n${routed.summary}` : "Use --execute only after enforce mode and approved holdout evidence select a redirect.", `Receipt: ${path.relative(projectDir, receipt)}`].join("\n"));
    });

  program
    .command("context-status")
    .description("Show the body-free Context Gateway operator status for a project")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--json", "print JSON")
    .action(async (options: { project: string; json?: boolean }) => {
      const report = await loadContextOperatorReport(ctx, path.resolve(process.cwd(), options.project));
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log([
        `Context Gateway status for ${report.projectName}`,
        `Policy: ${report.policyMode}; holdout ready: ${report.holdoutApproved ? "yes" : "no"}`,
        `Observations: ${report.efficiency.observations}; projected savings: ${report.efficiency.projectedSavingsPercent}%`,
        `Cache: ${report.cache.validEntries}/${report.cache.entries} valid (${report.cache.bytes} bytes)`,
        `Hosts: Claude ${report.hosts.claude ? "installed" : "not installed"}; Cursor ${report.hosts.cursor ? "installed" : "not installed"}; Codex ${report.hosts.codex ? "installed" : "not installed"}`,
        `Generation plans: ${report.codegen.awaitingReview} awaiting review, ${report.codegen.total} total`,
        `Calibration: ${report.calibration ? `${report.calibration.cases} cases; ready=${report.calibration.enforcementReady}` : "not run"}`
      ].join("\n"));
    });

  program
    .command("context-holdout")
    .description("Evaluate direct-versus-routed context cases before enforcement")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("--cases <path>", "JSON file containing holdout cases")
    .option("--json", "print JSON")
    .action(async (options: { project: string; cases: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const casesPath = path.resolve(process.cwd(), options.cases);
      const casesRaw = await fs.readFile(casesPath, "utf8");
      const cases = contextHoldoutCasesSchema.parse(JSON.parse(casesRaw));
      const report = evaluateContextHoldouts(cases);
      const evidencePath = await writeContextHoldoutEvidence({ projectDir, casesHash: contextSha256(casesRaw), report });
      if (options.json) console.log(JSON.stringify({ ...report, evidencePath: path.relative(projectDir, evidencePath) }, null, 2));
      else console.log([`Context holdout cases: ${report.cases}`, `Quality pass: ${(report.qualityPassRate * 100).toFixed(1)}%`, `Citation pass: ${(report.citationPassRate * 100).toFixed(1)}%`, `Token savings: ${report.tokenSavingsPercent}%`, `p95 added latency: ${report.p95AddedLatencyMs}ms`, `Enforcement ready: ${report.enforcementReady ? "yes" : "no"}`, `Evidence: ${path.relative(projectDir, evidencePath)}`].join("\n"));
      if (!report.enforcementReady) process.exitCode = 1;
    });

  program
    .command("context-promote")
    .description("Promote the Context Gateway beyond shadow mode after explicit approval and passing evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--mode <mode>", "advisory or enforce", "advisory")
    .option("--approved", "confirm that the passing holdout and calibration evidence was reviewed")
    .option("--write", "write the project-local policy, rollback snapshot, and receipt")
    .option("--json", "print JSON")
    .action(async (options: { project: string; mode: string; approved?: boolean; write?: boolean; json?: boolean }) => {
      if (options.mode !== "advisory" && options.mode !== "enforce") throw new Error("Context promotion mode must be advisory or enforce.");
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const report = await loadContextOperatorReport(ctx, projectDir);
      const gates = {
        holdoutApproved: report.holdoutApproved,
        calibrationReady: report.calibration?.enforcementReady === true,
        operatorApproved: options.approved === true
      };
      const canPromote = Object.values(gates).every(Boolean);
      const basePolicy = await loadContextRoutingPolicy(ctx, projectDir);
      const proposedPolicy = contextRoutingPolicySchema.parse({ ...basePolicy, mode: options.mode });
      const target = path.join(projectDir, ".agent-workflow", "context-routing.yaml");
      const result: Record<string, unknown> = { version: 1, projectId: report.projectId, from: basePolicy.mode, to: options.mode, gates, canPromote, writeRequested: options.write === true, written: false, target: path.relative(projectDir, target) };
      if (options.write) {
        if (!canPromote) throw new Error("Context promotion refused: passing holdout, passing calibration, and explicit --approved confirmation are all required.");
        const prior = await fs.readFile(target, "utf8").catch(() => YAML.stringify(basePolicy));
        const rollbackDir = path.join(projectDir, ".agent-workflow", "context-gateway", "rollbacks");
        await fs.mkdir(rollbackDir, { recursive: true, mode: 0o700 });
        const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
        const rollback = path.join(rollbackDir, `context-routing-${stamp}.yaml`);
        await fs.writeFile(rollback, prior, { mode: 0o600 });
        await fs.writeFile(target, YAML.stringify(proposedPolicy), { mode: 0o600 });
        const receipt = path.join(rollbackDir, `context-routing-${stamp}.receipt.json`);
        await fs.writeFile(receipt, `${JSON.stringify({ version: 1, promotedAt: new Date().toISOString(), from: basePolicy.mode, to: options.mode, priorHash: contextSha256(prior), nextHash: contextSha256(YAML.stringify(proposedPolicy)), gates, rollback: path.relative(projectDir, rollback), fileBodiesStored: false }, null, 2)}\n`, { mode: 0o600 });
        Object.assign(result, { written: true, rollback: path.relative(projectDir, rollback), receipt: path.relative(projectDir, receipt) });
      }
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log([`Context promotion: ${basePolicy.mode} -> ${options.mode}`, `Gates: holdout=${gates.holdoutApproved}; calibration=${gates.calibrationReady}; operator=${gates.operatorApproved}`, options.write ? `Written: ${result.written ? "yes" : "no"}` : "Preview only; use --approved --write after review."].join("\n"));
    });

  program
    .command("context-hook")
    .description("Evaluate a Claude Code, Cursor, or Codex file-read hook request from stdin")
    .requiredOption("--host <host>", "claude, cursor, or codex")
    .requiredOption("-p, --project <dir>", "project directory")
    .action(async (options: { host: string; project: string }) => {
      const host = parseContextHost(options.host);
      const projectDir = path.resolve(process.cwd(), options.project);
      const payload = JSON.parse(await readStandardInput());
      const read = normalizeHostRead(host, payload);
      if (!read) {
        process.stdout.write("{}\n");
        return;
      }
      const project = await loadProjectConfig(projectDir);
      const projectId = await upsertProject({ name: project.project.name, rootUri: projectDir, profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom", config: project });
      const requestedPath = path.isAbsolute(read.filePath) ? read.filePath : path.resolve(projectDir, read.filePath);
      const relativePath = path.relative(projectDir, requestedPath);
      const sourcePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath, label: "hook read" });
      const content = read.content ?? await fs.readFile(sourcePath, "utf8");
      const policy = await loadContextRoutingPolicy(ctx, projectDir);
      const decision = decideContextRoute({ policy, intent: "discovery", content });
      const holdoutApproved = await hasApprovedContextHoldout(projectDir);
      const enforcement = enforceContextDecision({ policy, decision, exactReadRequested: read.exactReadRequested, holdoutApproved });
      const observation = buildShadowObservation({ projectId, sourcePath: relativePath, content, intent: "discovery", policy, enforcedAction: enforcement.action });
      if (observation) await writeShadowObservationBatch({ projectRoot: projectDir, projectId, observations: [observation] });
      const redirectCommand = host === "codex"
        ? `call Agent Workflow MCP tool agentflow_context_route for ${JSON.stringify(relativePath)} with execute=true and holdoutApproved=true`
        : `agentflow context-route --project . --file ${JSON.stringify(relativePath)} --question ${JSON.stringify("Summarize the relevant parts of this file")} --intent discovery --mode enforce --holdout-approved --execute`;
      process.stdout.write(`${JSON.stringify(formatHostDecision({ host, action: enforcement.action, reason: enforcement.reason, route: decision.route, redirectCommand }))}\n`);
    });

  program
    .command("context-session-hook")
    .description("Provide host session guidance for automatic governed context routing")
    .requiredOption("--host <host>", "codex")
    .action((options: { host: string }) => {
      if (parseContextHost(options.host) !== "codex") throw new Error("Session context guidance is currently available for Codex only.");
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "For broad project file reads, prefer the connected Agent Workflow MCP tool agentflow_context_route. Use execute=true and holdoutApproved=true. Preserve targeted rg/searches and bounded reads; use exact=true or a direct read for high-risk, stale, low-confidence, or explicitly exact evidence." } })}\n`);
    });

  program
    .command("context-host-setup")
    .description("Preview or install a project-local Context Gateway host hook")
    .requiredOption("--host <host>", "claude, cursor, or codex")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--write", "merge the hook into the host configuration")
    .option("--json", "print JSON")
    .action(async (options: { host: string; project: string; write?: boolean; json?: boolean }) => {
      const host = parseContextHost(options.host);
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const definition = hostHookDefinition(host);
      const target = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: definition.relativePath, label: "host hook config" });
      let current: unknown = {};
      try { current = JSON.parse(await fs.readFile(target, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const merged = mergeHostHookConfig(host, current);
      if (options.write) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      }
      const report = { host, projectDir, target: definition.relativePath, written: Boolean(options.write), configured: JSON.stringify(merged).includes("agentflow context-hook"), config: merged };
      console.log(options.json ? JSON.stringify(report, null, 2) : [`Context host setup: ${host}`, `Target: ${definition.relativePath}`, `Configured: ${report.configured ? "yes" : "no"}`, `Written: ${report.written ? "yes" : "no"}`].join("\n"));
    });

  program
    .command("context-host-doctor")
    .description("Check Context Gateway policy, holdout evidence, and host-hook installation")
    .requiredOption("--host <host>", "claude, cursor, or codex")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--json", "print JSON")
    .action(async (options: { host: string; project: string; json?: boolean }) => {
      const host = parseContextHost(options.host);
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const definition = hostHookDefinition(host);
      const target = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: definition.relativePath, label: "host hook config" });
      let installed = false;
      try { installed = (await fs.readFile(target, "utf8")).includes("agentflow context-hook"); } catch { installed = false; }
      const policy = await loadContextRoutingPolicy(ctx, projectDir);
      const holdoutApproved = await hasApprovedContextHoldout(projectDir);
      const report = { host, installed, policyMode: policy.mode, holdoutApproved, enforcementReady: installed && policy.mode === "enforce" && holdoutApproved, target: definition.relativePath };
      console.log(options.json ? JSON.stringify(report, null, 2) : [`Context host doctor: ${host}`, `Installed: ${installed ? "yes" : "no"}`, `Policy: ${policy.mode}`, `Holdout approved: ${holdoutApproved ? "yes" : "no"}`, `Enforcement ready: ${report.enforcementReady ? "yes" : "no"}`].join("\n"));
    });

  program
    .command("context-codegen")
    .description("Stage or promote governed repetitive-code generation")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--spec <text>", "generation specification")
    .option("--reference <path>", "project-relative reference file")
    .option("--target <path>", "project-relative target file")
    .option("--plan <id>", "existing staged plan id to promote")
    .option("--approved", "confirm primary-agent diff review")
    .option("--reviewed-by <name>", "reviewer recorded in the promotion receipt")
    .option("--validate-command <command>", "allowed project validation command")
    .option("--json", "print JSON")
    .action(async (options: { project: string; spec?: string; reference?: string; target?: string; plan?: string; approved?: boolean; reviewedBy?: string; validateCommand?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const project = await loadProjectConfig(projectDir);
      if (!options.plan) {
        if (!options.spec || !options.reference || !options.target) throw new Error("New code-generation plans require --spec, --reference, and --target.");
        const referencePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: options.reference, label: "codegen reference" });
        const referenceContent = await fs.readFile(referencePath, "utf8");
        const provider = providerFromEnv();
        const output = await provider.executeStage({
          runId: randomUUID(), taskId: randomUUID(), projectConfig: project, workflowId: "context-codegen", workflowTask: `${options.spec}\nWrite only ${options.target}.`,
          stageId: "generate", agentId: "context-code-writer", agentName: "Context Code Writer",
          agentPrompt: "Generate repetitive code that follows the supplied reference. Return the candidate as a requestedFileWrite for the exact target. Do not request commands.",
          stageGoal: options.spec, compiledBrief: `Reference: ${options.reference}\n\n${referenceContent}`, modelTier: "fast", priorReceipts: []
        });
        const candidate = output.requestedFileWrites?.find((item) => item.path === options.target);
        if (!candidate || typeof candidate.content !== "string") throw new Error(`Provider ${provider.id} did not return full file content for the exact target ${options.target}.`);
        assertFileWriteAllowed(options.target, candidate.content, project);
        const created = await createCodegenPlan({ projectRoot: projectDir, target: options.target, reference: options.reference, referenceContent, candidateContent: candidate.content, spec: options.spec, provider: provider.id });
        const report = { planId: created.plan.id, status: created.plan.status, provider: provider.id, target: created.plan.target, referenceHash: created.plan.referenceHash, candidateHash: created.plan.candidateHash, diff: created.plan.diff, next: `Review the diff, then rerun with --plan ${created.plan.id} --approved --reviewed-by <name> --validate-command <allowed-command>.` };
        console.log(options.json ? JSON.stringify(report, null, 2) : [`Code-generation plan: ${report.planId}`, `Status: ${report.status}`, report.diff, report.next].join("\n"));
        return;
      }
      if (!options.approved || !options.reviewedBy?.trim() || !options.validateCommand?.trim()) throw new Error("Promotion requires --approved, --reviewed-by, and --validate-command.");
      const loaded = await readCodegenPlan(projectDir, options.plan);
      assertFileWriteAllowed(loaded.plan.target, loaded.candidate, project);
      const targetPath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: loaded.plan.target, label: "codegen target" });
      let previous: string | null = null;
      try { previous = await fs.readFile(targetPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const write = await executeAllowedFileWrite({ relativePath: loaded.plan.target, content: loaded.candidate, cwd: projectDir, project });
      const validation = await executeAllowedCommand({ commandLine: options.validateCommand, cwd: projectDir, project });
      if (validation.exitCode !== 0 || validation.timedOut) {
        if (previous === null) await fs.rm(targetPath, { force: true });
        else await executeAllowedFileWrite({ relativePath: loaded.plan.target, content: previous, cwd: projectDir, project });
        await finishCodegenPlan({ planPath: loaded.planPath, plan: loaded.plan, status: "failed", reviewedBy: options.reviewedBy, validation: `failed exit=${validation.exitCode} timedOut=${validation.timedOut}`, rollback: previous === null ? "removed newly created target" : "restored previous content" });
        throw new Error("Generated candidate failed validation and was rolled back.");
      }
      await finishCodegenPlan({ planPath: loaded.planPath, plan: loaded.plan, status: "promoted", reviewedBy: options.reviewedBy, validation: `passed: ${options.validateCommand}`, rollback: `previousHash=${write.previousHash ?? "new-file"}; candidateHash=${write.nextHash}` });
      const report = { planId: loaded.plan.id, status: "promoted", target: loaded.plan.target, reviewedBy: options.reviewedBy, validation: { command: options.validateCommand, exitCode: validation.exitCode, durationMs: validation.durationMs }, receipt: path.relative(projectDir, loaded.planPath), rollbackEvidence: `previousHash=${write.previousHash ?? "new-file"}; candidateHash=${write.nextHash}` };
      console.log(options.json ? JSON.stringify(report, null, 2) : [`Promoted ${report.target}.`, `Validation passed: ${options.validateCommand}`, `Receipt: ${report.receipt}`].join("\n"));
    });

}
