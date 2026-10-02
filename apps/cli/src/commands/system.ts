import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { DashboardRoleGovernanceReport } from "../lib/cli-types.js";
import { execFileText, loadAgentsForProject, objectValue } from "../lib/builders-shared.js";
import { loadAutoRoutePreviews, loadGovernanceReport, loadRoleGovernanceReport, updateEnvValue, writeRoleAuditSnapshot } from "../lib/builders-system.js";
import { loadAgents, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { buildGovernanceReport, formatGovernanceReport } from "../../../../packages/governance/src/index.js";
import { providerFromEnv, readEgressLog, summarizeEgress } from "../../../../packages/model-providers/src/index.js";
import { verifyRunReceiptChain } from "../../../../packages/storage/src/postgres.js";
import { buildSchemaSummary, buildVsCodeSettings } from "../../../../packages/schema-registry/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { parsePositiveInteger } from "../numeric-options.js";
import { normalizeProviderRef } from "../reference-resolution.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function registerSystemCommands(program: Command, ctx: CliContext): void {
  function formatRoleGovernanceReport(report: DashboardRoleGovernanceReport): string {
    const lines = [
      `Role governance (${report.generatedAt})`,
      `Project: ${report.projectRootUri ?? "all registered projects"}`,
      `Recent approvals: ${report.recentApprovals.length}`,
      `Filters: role=${report.filters.role ?? "all"} status=${report.filters.status} action=${report.filters.actionType ?? "all"}`,
      "",
      "Configured roles:"
    ];
    for (const project of report.projects) {
      lines.push(`- ${project.name} [${project.configStatus}]`);
      lines.push(`  ${project.rootUri}`);
      lines.push(`  enforcement=${project.enforcement} separationOfDuties=${project.separationOfDuties} default=${project.defaultActorRole}`);
      for (const role of project.roles) {
        lines.push(`  - ${role.id}: ${role.capabilities.join(", ") || "no capabilities"}${role.description ? ` - ${role.description}` : ""}`);
      }
    }
    lines.push("", "Recent decisions by role:");
    for (const role of report.decisionsByRole) {
      lines.push(`- ${role.role}: total=${role.total} pending=${role.pending} approved=${role.approved} rejected=${role.rejected} executed=${role.executed} failed=${role.failed}`);
    }
    return lines.join("\n");
  }

  async function runCodexCliLogin(deviceAuth: boolean): Promise<{ ready: boolean; detail: string }> {
    const binary = process.env.CODEX_CLI_BIN?.trim() || "codex";
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_ADMIN_KEY;

    const current = await execFileText(ctx, binary, ["login", "status"], { allowFailure: true, env: environment });
    if (current.exitCode === 0 && /logged in using chatgpt/iu.test(`${current.stdout}\n${current.stderr}`)) {
      return { ready: true, detail: "Codex CLI is already authenticated with ChatGPT." };
    }

    const args = ["login", ...(deviceAuth ? ["--device-auth"] : [])];
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(binary, args, { cwd: process.cwd(), env: environment, stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      return { ready: false, detail: exitCode === 127 ? "Codex CLI could not be started." : `Codex login failed with exit code ${exitCode}.` };
    }

    const verified = await execFileText(ctx, binary, ["login", "status"], { allowFailure: true, env: environment });
    const ready = verified.exitCode === 0 && /logged in using chatgpt/iu.test(`${verified.stdout}\n${verified.stderr}`);
    return ready
      ? { ready: true, detail: "Codex CLI authenticated with ChatGPT." }
      : { ready: false, detail: "Codex login completed, but ChatGPT authentication could not be verified." };
  }

  program
    .command("list")
    .description("List available agents and workflows")
    .option("-p, --project <dir>", "include project-local agents from .agent-workflow/agents")
    .action(async (options: { project?: string }) => {
      const agents = options.project
        ? await loadAgentsForProject(ctx, path.resolve(process.cwd(), options.project))
        : await loadAgents(ctx.rootDir);
      const workflows = await loadWorkflows(ctx.rootDir);

      console.log("Agents");
      for (const agent of agents) {
        console.log(`- ${agent.id} (${agent.display_name}) [${agent.category}] autonomy=${agent.autonomy}`);
      }

      console.log("\nWorkflows");
      for (const workflow of workflows) {
        console.log(`- ${workflow.id}: ${workflow.name} lead=${workflow.lead}`);
      }
    });

  program
    .command("doctor")
    .description("Check local enterprise services and workflow definitions")
    .option("--simple", "skip enterprise service checks")
    .action(async (options: { simple?: boolean }) => {
      const agents = await loadAgents(ctx.rootDir);
      const workflows = await loadWorkflows(ctx.rootDir);
      console.log(`Definitions: ${agents.length} agents, ${workflows.length} workflows`);

      if (options.simple) {
        console.log("Simple profile: enterprise service checks skipped.");
        return;
      }

      const checks = await checkServices();
      let failed = false;
      for (const check of checks) {
        const status = check.reachable ? "OK" : "MISSING";
        console.log(`${status}: ${check.endpoint.name} - ${check.message}`);
        if (!check.reachable && check.endpoint.requiredFor === "enterprise") {
          failed = true;
        }
      }

      if (failed) {
        console.log("\nStart local enterprise services with:");
        console.log("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
      }
    });

  program
    .command("provider-check")
    .description("Check selected model provider configuration")
    .action(async () => {
      if ((process.env.DEFAULT_MODEL_PROVIDER ?? "mock") === "auto") {
        const routes = await loadAutoRoutePreviews(ctx);
        console.log("Provider ready: auto");
        for (const route of routes) {
          console.log(`${route.tier}: ${route.providerId} (${route.estimatedCostTier})`);
          console.log(`  ${route.reason}`);
        }
        return;
      }

      const provider = providerFromEnv();
      if (!provider.check) {
        console.log(`Provider ready: ${provider.id}`);
        return;
      }

      const result = await provider.check();
      for (const detail of result.details) {
        console.log(detail);
      }
      if (!result.ready) {
        console.error(`Provider not ready: ${provider.id}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Provider ready: ${provider.id}`);
    });

  program
    .command("provider-use")
    .alias("model-use")
    .description("Switch DEFAULT_MODEL_PROVIDER in .env")
    .argument("<provider>", "auto, mock, local, byo, openai, codex-cli, anthropic, gemini, muse, openai-compatible, bedrock, or kiro")
    .option("--login", "authenticate interactively before selecting a CLI provider")
    .option("--device-auth", "use Codex device-code login for a headless machine")
    .option("--check", "run provider-check after switching")
    .action(async (provider: string, options: { check?: boolean; login?: boolean; deviceAuth?: boolean }) => {
      const supported = ["auto", "mock", "local", "byo", "openai", "codex-cli", "anthropic", "gemini", "muse", "openai-compatible", "bedrock", "kiro"];
      const providerId = normalizeProviderRef(provider);
      if (!supported.includes(providerId)) {
        console.error(`Unsupported provider: ${provider}`);
        console.error(`Use one of: ${supported.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      if (options.deviceAuth && !options.login) {
        console.error("--device-auth requires --login.");
        process.exitCode = 1;
        return;
      }
      if (options.login && providerId !== "codex-cli") {
        console.error("--login is currently supported only for codex-cli.");
        process.exitCode = 1;
        return;
      }
      if (options.login) {
        const loginResult = await runCodexCliLogin(Boolean(options.deviceAuth));
        if (!loginResult.ready) {
          console.error(loginResult.detail);
          process.exitCode = 1;
          return;
        }
        console.log(loginResult.detail);
        await updateEnvValue(ctx.configuredEnvPath, "CODEX_CLI_AUTH_MODE", "chatgpt");
        process.env.CODEX_CLI_AUTH_MODE = "chatgpt";
      }

      await updateEnvValue(ctx.configuredEnvPath, "DEFAULT_MODEL_PROVIDER", providerId);
      process.env.DEFAULT_MODEL_PROVIDER = providerId;
      console.log(`DEFAULT_MODEL_PROVIDER=${providerId}`);

      if (providerId === "openai") {
        console.log("Using OpenAI Responses API. Requires OPENAI_API_KEY. Set OPENAI_MODEL=auto to select tier models from the live OpenAI catalog.");
      } else if (providerId === "codex-cli") {
        console.log("Using the authenticated Codex CLI. Defaults to ChatGPT subscription auth and never reads the Codex credential cache directly.");
      } else if (providerId === "anthropic") {
        console.log("Using Anthropic Messages API. Requires ANTHROPIC_API_KEY. Set ANTHROPIC_MODEL=auto to select tier models from the live Anthropic catalog.");
      } else if (providerId === "gemini") {
        console.log("Using Gemini through Google's official OpenAI-compatible endpoint. Requires GEMINI_API_KEY or GOOGLE_API_KEY; GEMINI_MODEL defaults to gemini-3.8-flash.");
      } else if (providerId === "muse") {
        console.log("Using Meta Muse via the Meta Model API. Requires MUSE_API_KEY. MUSE_MODEL defaults to muse-spark-1.1.");
      } else if (providerId === "auto") {
        console.log("Using auto routing. Agent Workflow will pick a ready provider per stage tier.");
      } else if (providerId === "byo") {
        console.log("Using BYO model provider. Requires BYO_MODEL_BASE_URL and BYO_MODEL_NAME; BYO_MODEL_API_KEY is optional.");
      } else if (providerId === "local") {
        console.log("Using the local OpenAI-compatible runtime. Configure LOCAL_MODEL_BASE_URL and LOCAL_MODEL_NAME; LOCAL_MODEL_API_KEY is optional.");
      } else if (providerId === "kiro") {
        console.log("Using Kiro CLI provider. Requires `kiro-cli login` or KIRO_API_KEY, optional KIRO_AGENT.");
      } else if (providerId === "bedrock") {
        console.log("Using AWS Bedrock provider. Requires AWS credentials and optional BEDROCK_MODEL/AWS_REGION.");
      }

      if (options.check) {
        if (providerId === "auto") {
          const routes = await loadAutoRoutePreviews(ctx);
          for (const route of routes) {
            console.log(`${route.tier}: ${route.providerId} (${route.estimatedCostTier})`);
            console.log(`  ${route.reason}`);
          }
          return;
        }

        const selected = providerFromEnv();
        if (!selected.check) {
          console.log(`Provider ready: ${selected.id}`);
          return;
        }
        const result = await selected.check();
        for (const detail of result.details) {
          console.log(detail);
        }
        if (!result.ready) {
          console.error(`Provider not ready: ${selected.id}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Provider ready: ${selected.id}`);
      }
    });

  program
    .command("schemas")
    .description("List JSON Schemas and optionally write VS Code/Cursor YAML validation settings")
    .option("-p, --project <dir>", "project directory for editor settings")
    .option("--write-vscode", "write .vscode/settings.json YAML schema associations")
    .option("--json", "print machine-readable schema registry output")
    .action(async (options: { project?: string; writeVscode?: boolean; json?: boolean }) => {
      const schemas = buildSchemaSummary(ctx.rootDir);
      const vscode = buildVsCodeSettings(ctx.rootDir);
      let settingsPath: string | undefined;
      let settingsStatus: "not-requested" | "written" | "unchanged" = "not-requested";

      if (options.writeVscode) {
        if (!options.project) throw new Error("--write-vscode requires --project");
        const projectDir = path.resolve(process.cwd(), options.project);
        settingsPath = path.join(projectDir, ".vscode", "settings.json");
        const existing = objectValue(await ctx.readJsonFile<Record<string, unknown>>(settingsPath));
        const existingYamlSchemas = objectValue(existing["yaml.schemas"]);
        const nextSettings = {
          ...existing,
          "yaml.schemas": {
            ...existingYamlSchemas,
            ...objectValue(vscode["yaml.schemas"])
          }
        };
        const nextContent = `${JSON.stringify(nextSettings, null, 2)}\n`;
        let currentContent: string | undefined;
        try { currentContent = await fs.readFile(settingsPath, "utf8"); } catch {}
        settingsStatus = currentContent === nextContent ? "unchanged" : "written";
        if (settingsStatus === "written") {
          await fs.mkdir(path.dirname(settingsPath), { recursive: true });
          await fs.writeFile(settingsPath, nextContent, "utf8");
        }
      }

      const result = { schemas, vscode, settingsPath, settingsStatus };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("Agent Workflow Schemas");
      for (const schema of schemas) {
        console.log(`- ${schema.id}: ${schema.path}`);
        console.log(`  Files: ${schema.fileGlobs.join(", ")}`);
      }
      if (settingsPath) console.log(`${settingsStatus.toUpperCase()}: ${settingsPath}`);
      else console.log("\nEditor setup: npm run agentflow -- schemas --write-vscode --project /path/to/project");
    });

  program
    .command("governance")
    .description("Inspect registered projects for health, policy drift, providers, queues, and remediation guidance")
    .option("--health <status>", "healthy, warning, critical, or all", "all")
    .option("--provider <provider>", "filter by provider")
    .option("--policy-profile <profile>", "filter by policy profile")
    .option("--stale-minutes <number>", "running age considered stale", "15")
    .option("--include-ephemeral", "include temporary provider-smoke projects")
    .option("--json", "print machine-readable governance report")
    .action(async (options: { health: string; provider?: string; policyProfile?: string; staleMinutes: string; includeEphemeral?: boolean; json?: boolean }) => {
      if (!["all", "healthy", "warning", "critical"].includes(options.health)) throw new Error("--health must be healthy, warning, critical, or all");
      const report = await loadGovernanceReport(ctx, parsePositiveInteger(options.staleMinutes, 15), Boolean(options.includeEphemeral));
      const projects = report.projects.filter((project) =>
        (options.health === "all" || project.health === options.health) &&
        (!options.provider || project.provider === options.provider) &&
        (!options.policyProfile || project.policyProfile === options.policyProfile)
      );
      const filtered = buildGovernanceReport(report.bundleVersion, report.servicesReady, projects, report.configuredProvider, report.definitionsReady);
      console.log(options.json ? JSON.stringify(filtered, null, 2) : formatGovernanceReport(filtered));
      if (!filtered.servicesReady || !filtered.definitionsReady || filtered.counts.critical > 0) process.exitCode = 2;
    });

  program
    .command("roles")
    .description("Inspect project team roles and recent approval decisions by role")
    .option("-p, --project <dir>", "filter by project directory")
    .option("-l, --limit <number>", "number of recent approvals to inspect", "50")
    .option("--role <role>", "filter approvals by decided or executed role")
    .option("--status <status>", "filter approvals by status, or all", "all")
    .option("--action <action>", "filter approvals by action type")
    .option("--export", "write Markdown and JSON role audit snapshot files")
    .option("-o, --out <dir>", "export directory; defaults to project-local or repo-local .agent-workflow/exports/roles")
    .option("--json", "print machine-readable role governance report")
    .action(async (options: { project?: string; limit: string; role?: string; status: string; action?: string; export?: boolean; out?: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const report = await loadRoleGovernanceReport(ctx, {
        projectRootUri: options.project,
        limit: parsePositiveInteger(options.limit, 50),
        role: options.role,
        status: options.status,
        actionType: options.action
      });
      if (options.export) {
        const exported = await writeRoleAuditSnapshot(ctx, report, options.out);
        console.log(`Role audit snapshot written:`);
        console.log(`- Markdown: ${exported.markdownPath}`);
        console.log(`- JSON: ${exported.jsonPath}`);
        if (!options.json) return;
      }
      console.log(options.json ? JSON.stringify(report, null, 2) : formatRoleGovernanceReport(report));
    });

  program
    .command("egress-log")
    .description("Show recent outbound network calls made by model providers")
    .option("--limit <n>", "max entries to show", "50")
    .option("--summary", "summarize by provider and host instead of listing entries")
    .option("--json", "output as JSON")
    .action(async (options: { limit?: string; summary?: boolean; json?: boolean }) => {
      const limit = parsePositiveInteger(options.limit ?? "50", 50);
      if (options.summary) {
        const summary = summarizeEgress();
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }
        if (summary.length === 0) {
          console.log("No egress recorded in this session.");
          return;
        }
        console.log("Egress summary (this session):");
        for (const s of summary) {
          console.log(`- ${s.providerId} -> ${s.host}: ${s.calls} calls, ${s.promptTokens + s.completionTokens} tokens, ${s.errors} errors`);
        }
        return;
      }
      const entries = readEgressLog(limit);
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log("No egress recorded in this session.");
        return;
      }
      for (const e of entries) {
        const tokens = e.promptTokens !== undefined ? ` ${e.promptTokens}+${e.completionTokens ?? 0}tok` : "";
        const err = e.error ? ` ERROR: ${e.error.slice(0, 80)}` : "";
        console.log(`${e.timestamp} ${e.providerId} ${e.method} ${e.host}${e.endpoint}${tokens} ${e.durationMs}ms${err}`);
      }
    });

  program
    .command("verify-receipts")
    .description("Verify the tamper-evident hash chain of action receipts for a run")
    .requiredOption("--run <id>", "run id to verify")
    .option("--json", "output as JSON")
    .action(async (options: { run: string; json?: boolean }) => {
      const result = await verifyRunReceiptChain(options.run);
      if (options.json) {
        console.log(JSON.stringify({ runId: options.run, ...result }, null, 2));
        return;
      }
      if (result.valid) {
        console.log(`Receipt chain valid: ${result.checked} receipt(s) verified for run ${options.run}.`);
      } else {
        console.error(`Receipt chain BROKEN for run ${options.run}:`);
        console.error(`  Checked: ${result.checked}, broken at index ${result.brokenAt}`);
        console.error(`  Reason: ${result.reason}`);
        process.exitCode = 1;
      }
    });

}
