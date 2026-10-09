import type { CliContext } from "./context.js";
import type { DashboardProjectAliasMergeGroup, DashboardProjectAliasMergePlan, DashboardProjectAliasMergeProject, DashboardProjectIdentityGroup, DashboardProjectSummary, OnboardingResult, ProjectDiscoveryAdoptionItem, ProjectDiscoveryAdoptionResult, ProjectDiscoveryCandidate, ProjectDiscoveryReport, SpotlightMode } from "./cli-types.js";
import { writeProjectBundleState } from "./builders-bundle.js";
import { discoverProjectRoadmap, orderedUnique } from "./builders-learning.js";
import { commandAvailable, execFileText, exists, indexProjectForRun, objectValue, pathExists, resolveDashboardProjectPath, shellQuote, stringValue } from "./builders-shared.js";
import { type ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import { resolveContainedProjectPath } from "../../../../packages/roadmap-planner/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { listProjectStorageSummaries } from "../../../../packages/storage/src/postgres.js";
import { logicalProjectIdentityKeys, projectIdentityVisibility } from "../dashboard/project-identity.js";
import { commandPrefixForPackageManager, detectFrameworks, detectLanguages, detectMarkers, detectPackageManager } from "../onboarding-detection.js";
import { recommendAgents, recommendCommands, recommendContextExcludes, recommendContextIncludes, recommendWorkflows, recommendWritePaths } from "../onboarding-recommendations.js";
import { normalizeLookup } from "../reference-resolution.js";
import { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export async function addDiscoveryCandidate(byRoot: Map<string, ProjectDiscoveryCandidate>, candidateRoot: string, source: ProjectDiscoveryCandidate["source"], registered: Set<string>): Promise<void> {
  const rootUri = path.resolve(candidateRoot);
  if (isDiscoveryPathExcluded(rootUri)) return;
  const markers = await readDiscoveryMarkers(rootUri);
  if (!markers.length) return;
  const existing = byRoot.get(rootUri);
  const combinedSource = existing && existing.source !== source ? "combined" : source;
  const initialized = markers.includes(".agent-workflow") && markers.includes("AGENTS.md");
  const candidate: ProjectDiscoveryCandidate = {
    rootUri,
    name: path.basename(rootUri),
    markers: orderedUnique([...(existing?.markers ?? []), ...markers]).sort(),
    source: combinedSource,
    confidence: discoveryConfidence(markers),
    initialized,
    registered: registered.has(rootUri),
    suggestedCommands: initialized
      ? [`npm run index-project -- --project ${shellQuote(rootUri)} --max-files 100`]
      : [`npm run init-project -- --project ${shellQuote(rootUri)} --profile enterprise`, `npm run index-project -- --project ${shellQuote(rootUri)} --max-files 100`]
  };
  byRoot.set(rootUri, candidate);
}

export async function adoptDiscoveredProjects(ctx: CliContext, input: {
  roots: string[];
  paths: string[];
  all: boolean;
  initialize: boolean;
  index: boolean;
  profile: "enterprise" | "simple";
  maxDepth: number;
  maxCandidates: number;
  maxFiles: number;
  spotlight: SpotlightMode;
  write: boolean;
}): Promise<ProjectDiscoveryAdoptionResult> {
  const warnings: string[] = [];
  if (!input.initialize && !input.index) {
    warnings.push("No action selected. Use --initialize, --index, or both.");
  }
  if (!input.all && !input.paths.length) {
    warnings.push("No candidates selected. Use --paths <path[,path]> or --all.");
  }
  const discovered = await discoverLocalProjects(ctx, {
    roots: input.roots,
    maxDepth: input.maxDepth,
    maxCandidates: input.maxCandidates,
    spotlight: input.spotlight
  });
  warnings.push(...discovered.warnings);
  const selectedPaths = new Set(input.paths.map((item) => path.resolve(process.cwd(), item)));
  const candidates = discovered.candidates.filter((candidate) => input.all || selectedPaths.has(candidate.rootUri));
  const items: ProjectDiscoveryAdoptionItem[] = [];
  let initialized = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let servicesReady = !input.write || !input.index;

  if (input.write && input.index) {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      return {
        kind: "agentflow_project_discovery_adoption",
        ok: false,
        generatedAt: new Date().toISOString(),
        dryRun: !input.write,
        selected: candidates.length,
        initialized: 0,
        indexed: 0,
        skipped: candidates.length,
        failed: missing.length,
        items: candidates.map((candidate) => ({
          rootUri: candidate.rootUri,
          name: candidate.name,
          initializedBefore: candidate.initialized,
          registeredBefore: candidate.registered,
          actions: plannedDiscoveryActions(candidate, input),
          status: "failed",
          message: missing.map((check) => `${check.endpoint.name}: ${check.message}`).join("; ")
        })),
        warnings
      };
    }
    servicesReady = true;
  }

  for (const candidate of candidates) {
    const actions = plannedDiscoveryActions(candidate, input);
    if (!actions.length) {
      skipped += 1;
      items.push({
        rootUri: candidate.rootUri,
        name: candidate.name,
        initializedBefore: candidate.initialized,
        registeredBefore: candidate.registered,
        actions,
        status: "skipped",
        message: "No applicable action for this candidate."
      });
      continue;
    }
    if (!input.write) {
      items.push({
        rootUri: candidate.rootUri,
        name: candidate.name,
        initializedBefore: candidate.initialized,
        registeredBefore: candidate.registered,
        actions,
        status: "planned",
        message: "Dry run only. Re-run with --write to perform these actions."
      });
      continue;
    }
    try {
      let initializedNow = candidate.initialized;
      const messages: string[] = [];
      if (input.initialize && !candidate.initialized) {
        const onboarding = await analyzeProjectForOnboarding(ctx, candidate.rootUri, input.profile);
        const writeResult = await writeOnboardingFiles(ctx, candidate.rootUri, onboarding, false);
        initializedNow = true;
        initialized += 1;
        messages.push(`initialized: wrote ${writeResult.written.length}, skipped ${writeResult.skipped.length}`);
      }
      if (input.index && initializedNow && servicesReady) {
        const indexResult = await indexProjectForRun(ctx, {
          projectDir: candidate.rootUri,
          maxFiles: input.maxFiles,
          refine: false,
          forceRefine: false,
          fullIndex: true
        });
        indexed += 1;
        messages.push(`indexed ${indexResult.count} file summary row(s) for ${indexResult.projectName}`);
      }
      items.push({
        rootUri: candidate.rootUri,
        name: candidate.name,
        initializedBefore: candidate.initialized,
        registeredBefore: candidate.registered,
        actions,
        status: "completed",
        message: messages.join("; ") || "No changes needed."
      });
    } catch (error) {
      failed += 1;
      items.push({
        rootUri: candidate.rootUri,
        name: candidate.name,
        initializedBefore: candidate.initialized,
        registeredBefore: candidate.registered,
        actions,
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    kind: "agentflow_project_discovery_adoption",
    ok: warnings.length === 0 && failed === 0,
    generatedAt: new Date().toISOString(),
    dryRun: !input.write,
    selected: candidates.length,
    initialized,
    indexed,
    skipped,
    failed,
    items,
    warnings
  };
}

export async function analyzeProjectForOnboarding(ctx: CliContext, projectDir: string, profile: "enterprise" | "simple"): Promise<OnboardingResult> {
  if (!await exists(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  const packageJson = await ctx.readJsonFile<Record<string, unknown>>(path.join(projectDir, "package.json"));
  const packageScripts = objectValue(packageJson?.scripts);
  const dependencies = {
    ...objectValue(packageJson?.dependencies),
    ...objectValue(packageJson?.devDependencies)
  };
  const packageManager = await detectPackageManager(projectDir, packageJson);
  const commandPrefix = commandPrefixForPackageManager(packageManager);
  const markers = await detectMarkers(projectDir);
  const frameworks = detectFrameworks(dependencies, markers);
  const languages = detectLanguages(packageJson, markers);
  const name = stringValue(packageJson?.name) ?? path.basename(projectDir);
  const roadmap = await discoverProjectRoadmap(projectDir);
  const allowedCommands = recommendCommands(packageScripts, commandPrefix, markers);
  const contextInclude = recommendContextIncludes(markers, frameworks, languages);
  const contextExclude = recommendContextExcludes(frameworks, languages);
  const allowedWritePaths = recommendWritePaths(frameworks, languages);
  const suggestedAgents = recommendAgents(frameworks, languages, markers);
  const defaultWorkflows = recommendWorkflows(frameworks, languages, markers);
  const recommendedFirstWorkflow = defaultWorkflows.includes("production-readiness") ? "production-readiness" : "review-pr";
  const recommendedFirstTask = recommendedFirstWorkflow === "production-readiness"
    ? "Review production readiness, UX, SEO, mobile experience, security, and launch risks"
    : "Review the current project setup and code quality risks";

  const config: ProjectConfig = {
    project: {
      name,
      summary: summarizeDetectedProject(frameworks, languages, markers),
      roadmap_path: roadmap.relativePath,
      default_workflows: defaultWorkflows,
      autonomy: profile === "enterprise" ? 3 : 2
    },
    context: {
      include: contextInclude,
      exclude: contextExclude,
      max_project_tokens: frameworks.includes("static-site") ? 14000 : 12000
    },
    storage: {
      cache_summaries: profile === "enterprise",
      semantic_index: profile === "enterprise",
      artifact_lifecycle: {
        retention_days: 30,
        min_prune_bytes: 20_000,
        retain_audit_artifacts: true,
        legal_hold: false,
        require_approval_for_prune: true,
        allow_archive_execution: false,
        allow_restore_execution: false,
        allow_prune_execution: false
      }
    },
    execution: {
      policy_profile: "local",
      policy_profiles: {},
      worker_pool: {
        worker_id: "local-dev",
        allowed_platforms: [],
        limit: 6,
        concurrency: 4,
        per_project_concurrency: 2,
        lease_seconds: 120,
        interval_ms: 2000,
        project_scoped: true,
        default_profile: "local",
        profiles: {
          local: {
            description: "Default single-lane local developer worker pool.",
            lanes: [{ id: "default" }]
          },
          "split-review": {
            description: "Separate implementation and review lanes for local development.",
            lanes: [
              { id: "implementation", worker_id: "implementation-lane", limit: 6, concurrency: 2 },
              { id: "review", worker_id: "review-lane", limit: 3, concurrency: 1 }
            ]
          }
        }
      }
    },
    policies: {
      allow_wide_open: false,
      require_approval_for_external_actions: true,
      require_receipts: true
    },
    team: {
      enforcement: "preview",
      default_actor_role: "operator",
      separation_of_duties: {
        mode: "off",
        prevent_same_actor_approval_execution: true
      },
      roles: {
        operator: {
          description: "Runs local workflows and executes approved local actions.",
          can_request_approvals: true,
          can_approve_actions: false,
          can_reject_actions: false,
          can_execute_approved_actions: true,
          can_author_workflows: false,
          read_only: false
        },
        approver: {
          description: "Reviews and decides pending action, deployment, and autonomy approvals.",
          can_request_approvals: false,
          can_approve_actions: true,
          can_reject_actions: true,
          can_execute_approved_actions: false,
          can_author_workflows: false,
          read_only: false
        },
        workflow_author: {
          description: "Reviews or edits reusable/project-local workflow definitions.",
          can_request_approvals: false,
          can_approve_actions: false,
          can_reject_actions: false,
          can_execute_approved_actions: false,
          can_author_workflows: true,
          read_only: false
        },
        auditor: {
          description: "Reviews run evidence, receipts, exports, and governance reports.",
          can_request_approvals: false,
          can_approve_actions: false,
          can_reject_actions: false,
          can_execute_approved_actions: false,
          can_author_workflows: false,
          read_only: true
        }
      }
    },
    actions: {
      allowed_commands: allowedCommands,
      blocked_commands: [
        "rm *",
        "git reset *",
        "git clean *",
        "sudo *",
        "curl *",
        "wget *",
        "ssh *",
        "scp *"
      ],
      command_timeout_ms: 120000,
      max_output_chars: 20000,
      allowed_write_paths: allowedWritePaths,
      blocked_write_paths: [
        ".git/**",
        "node_modules/**",
        ".env",
        ".env.*",
        ".agent-workflow/schedule-state.json",
        "**/.next/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**"
      ],
      max_write_bytes: 250000,
      allowed_read_paths: allowedWritePaths,
      blocked_read_paths: [
        ".git/**",
        "node_modules/**",
        ".env",
        ".env.*",
        "**/*.pem",
        "**/*.key"
      ],
      max_read_bytes: 250000,
      auto_approve_max_risk: "none",
      approval_rules: []
    }
  };

  return {
    projectDir,
    profile,
    detected: {
      name,
      packageManager,
      frameworks,
      languages,
      markers,
      roadmapPath: roadmap.relativePath,
      roadmapExists: roadmap.exists
    },
    recommendations: {
      contextInclude,
      contextExclude,
      allowedCommands,
      blockedCommands: config.actions.blocked_commands,
      suggestedAgents,
      defaultWorkflows,
      nextCommands: [
        `npm run onboard-project -- --project ${projectDir} --profile ${profile} --write`,
        `npm run index-project -- --project ${projectDir} --max-files 100`,
        `npm run agentflow -- run-and-watch ${recommendedFirstWorkflow} --project ${projectDir} --task "${recommendedFirstTask}" --index-max-files 100 --worker-limit 6`
      ]
    },
    config,
    dryRun: {
      valid: true,
      notes: [
        "No files written unless --write is provided.",
        roadmap.exists
          ? `Existing roadmap will be preserved at ${roadmap.relativePath}.`
          : `A blank roadmap will be created at ${roadmap.relativePath} when --write is provided.`,
        "External network commands are blocked by default.",
        "Writes to .env, .git, node_modules, build output, and coverage output are blocked.",
        "Review allowed commands before enabling higher autonomy."
      ]
    }
  };
}

export function buildDashboardProjectAliasMergeGroup(identity: DashboardProjectIdentityGroup): DashboardProjectAliasMergeGroup {
  const sortedProjects = [...identity.projects].sort((left, right) => {
    const leftPrimary = left.rootUri === identity.primaryRootUri ? 1 : 0;
    const rightPrimary = right.rootUri === identity.primaryRootUri ? 1 : 0;
    return rightPrimary - leftPrimary
      || right.runCount - left.runCount
      || right.indexedFiles - left.indexedFiles
      || (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? "")
      || left.rootUri.localeCompare(right.rootUri);
  });
  const targetProject = sortedProjects[0];
  const sourceProjects = sortedProjects.slice(1);
  const target = dashboardProjectAliasMergeProject(targetProject);
  const sources = sourceProjects.map(dashboardProjectAliasMergeProject);
  const impactedRows = {
    projectRows: sourceProjects.length,
    workflowRuns: sources.reduce((sum, project) => sum + project.runCount, 0),
    activeRuns: sources.reduce((sum, project) => sum + project.activeRuns, 0),
    failedRuns: sources.reduce((sum, project) => sum + project.failedRuns, 0),
    projectFiles: sources.reduce((sum, project) => sum + project.indexedFiles, 0),
    memoryItems: sources.reduce((sum, project) => sum + project.memoryItems, 0),
    indexedTokens: sources.reduce((sum, project) => sum + project.indexedTokens, 0),
    indirectRunArtifacts: "via workflow_runs after project_id reassignment"
  };
  const conflictWarnings = buildProjectAliasMergeWarnings(target, sources, impactedRows);
  const risk: DashboardProjectAliasMergeGroup["risk"] = impactedRows.activeRuns > 0 || conflictWarnings.length > 2
    ? "high"
    : impactedRows.projectFiles > 0 || impactedRows.memoryItems > 0
      ? "medium"
      : "low";
  return {
    canonicalRootUri: identity.canonicalRootUri,
    target,
    sources,
    impactedRows,
    risk,
    conflictWarnings,
    preflightChecks: [
      "Run storage-merge-evidence and storage-verify immediately before execution.",
      "Create a point-in-time database backup and object-storage inventory.",
      "Confirm no source project alias has queued or running workflow runs.",
      "Detect duplicate project_files.source_uri rows and preserve newer content_hash/token evidence.",
      "Keep the source root_uri values as aliases in an auditable receipt before deleting or tombstoning rows."
    ],
    rollbackOutline: [
      "Restore the database backup for a full rollback, or replay the generated mapping receipt to move project_id references back to each source project id.",
      "Recreate source project rows from the pre-merge snapshot if they were tombstoned or removed.",
      "Re-run storage-verify, project identity grouping, and a small workflow smoke test after rollback."
    ]
  };
}

export function buildDashboardProjectAliasMergePlan(
  projects: DashboardProjectSummary[],
  identities: DashboardProjectIdentityGroup[]
): DashboardProjectAliasMergePlan {
  const groups = identities
    .filter((identity) => identity.projects.length > 1)
    .map((identity) => buildDashboardProjectAliasMergeGroup(identity));
  const sourceProjectCount = groups.reduce((sum, group) => sum + group.sources.length, 0);
  return {
    kind: "agentflow_project_alias_merge_plan",
    generatedAt: new Date().toISOString(),
    dryRun: true,
    identityCount: identities.length,
    projectCount: projects.length,
    candidateCount: groups.length,
    sourceProjectCount,
    groups,
    summary: groups.length
      ? [
          `${groups.length} logical project identity group(s) have duplicate registered roots.`,
          `${sourceProjectCount} source project row(s) could be consolidated into canonical targets after backup and conflict checks.`,
          "This report is dry-run only; it does not update workflow runs, indexed files, memory items, approvals, or project rows."
        ]
      : [
          "No duplicate project identity groups were found.",
          "No project alias merge is recommended right now."
        ]
  };
}

export function buildProjectAliasMergeWarnings(
  target: DashboardProjectAliasMergeProject,
  sources: DashboardProjectAliasMergeProject[],
  impactedRows: DashboardProjectAliasMergeGroup["impactedRows"]
): string[] {
  const warnings: string[] = [];
  if (impactedRows.activeRuns > 0) warnings.push("One or more source aliases have active runs; wait until they are terminal before merging.");
  if (target.indexedFiles > 0 && impactedRows.projectFiles > 0) warnings.push("Target and source aliases both have indexed files; execution must de-duplicate source_uri/content_hash rows.");
  if (target.memoryItems > 0 && impactedRows.memoryItems > 0) warnings.push("Target and source aliases both have memory items; execution should preserve provenance and avoid duplicate summaries.");
  if (new Set([target.profile, ...sources.map((source) => source.profile)]).size > 1) warnings.push("Project aliases use different profiles; execution must choose a final profile intentionally.");
  if (sources.some((source) => source.rootUri.startsWith("/home/")) && target.rootUri.startsWith("/Users/")) warnings.push("Linux and macOS home aliases are present; keep path mapping documented for shared shared host storage.");
  return warnings;
}

export function candidateRank(candidate: ProjectDiscoveryCandidate): number {
  const confidenceScore = candidate.confidence === "high" ? 1000 : candidate.confidence === "medium" ? 500 : 100;
  return confidenceScore + candidate.markers.length * 10 + (candidate.registered ? 5 : 0) + (candidate.initialized ? 3 : 0);
}

export function dashboardProjectAliasMergeProject(project: DashboardProjectSummary): DashboardProjectAliasMergeProject {
  return {
    id: project.id,
    name: project.name,
    rootUri: project.rootUri,
    profile: project.profile,
    indexedFiles: project.indexedFiles,
    indexedTokens: project.indexedTokens,
    memoryItems: project.memoryItems,
    runCount: project.runCount,
    completedRuns: project.completedRuns,
    failedRuns: project.failedRuns,
    activeRuns: project.queuedRuns + project.runningRuns,
    lastRunAt: project.lastRunAt
  };
}

export async function discoverLocalProjects(ctx: CliContext, input: {
  roots: string[];
  maxDepth: number;
  maxCandidates: number;
  spotlight: SpotlightMode;
}): Promise<ProjectDiscoveryReport> {
  const warnings: string[] = [];
  const registered = new Set((await listProjectStorageSummaries(500).catch(() => [])).map((project) => path.resolve(project.rootUri)));
  const roots = orderedUnique(input.roots.map((root) => path.resolve(process.cwd(), root)));
  const byRoot = new Map<string, ProjectDiscoveryCandidate>();
  const useSpotlight = input.spotlight !== "off" && process.platform === "darwin";
  const spotlightAvailable = useSpotlight ? (await commandAvailable(ctx, "mdfind")) : false;
  if (input.spotlight === "on" && !spotlightAvailable) {
    warnings.push("Spotlight requested, but mdfind is unavailable. Used filesystem discovery only.");
  }
  if (spotlightAvailable) {
    for (const root of roots) {
      const candidates = await discoverProjectsWithSpotlight(ctx, root, input.maxCandidates).catch((error) => {
        warnings.push(`Spotlight discovery failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      for (const candidateRoot of candidates) {
        await addDiscoveryCandidate(byRoot, candidateRoot, "spotlight", registered);
      }
    }
  }
  for (const root of roots) {
    const candidates = await discoverProjectsWithFilesystem(root, input.maxDepth, input.maxCandidates).catch((error) => {
      warnings.push(`Filesystem discovery failed for ${root}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    for (const candidateRoot of candidates) {
      await addDiscoveryCandidate(byRoot, candidateRoot, "filesystem", registered);
    }
  }
  const candidates = [...byRoot.values()]
    .sort((left, right) => candidateRank(right) - candidateRank(left) || left.rootUri.localeCompare(right.rootUri))
    .slice(0, input.maxCandidates);
  return {
    kind: "agentflow_project_discovery_report",
    generatedAt: new Date().toISOString(),
    roots,
    maxDepth: input.maxDepth,
    maxCandidates: input.maxCandidates,
    spotlight: {
      requested: input.spotlight,
      used: spotlightAvailable,
      available: spotlightAvailable
    },
    excludes: discoveryExcludedSegments,
    candidates,
    warnings,
    nextCommands: [
      "Review candidates before initializing or indexing.",
      "Initialize a candidate: npm run init-project -- --project <path> --profile enterprise",
      "Index an initialized candidate: npm run index-project -- --project <path> --max-files 100",
      "For whole-drive discovery on macOS: npm run agentflow -- discover-projects --roots / --spotlight auto --max-depth 6 --write"
    ]
  };
}

export async function discoverProjectsWithFilesystem(root: string, maxDepth: number, maxCandidates: number): Promise<string[]> {
  if (!await pathExists(root)) return [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const candidates = new Set<string>();
  while (queue.length && candidates.size < maxCandidates) {
    const current = queue.shift();
    if (!current || isDiscoveryPathExcluded(current.dir, root)) continue;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (discoveryMarkerFiles.some((marker) => names.has(marker))) {
      candidates.add(current.dir);
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || discoveryExcludedSegments.includes(entry.name)) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return [...candidates];
}

export async function discoverProjectsWithSpotlight(ctx: CliContext, root: string, maxCandidates: number): Promise<string[]> {
  if (!await pathExists(root)) return [];
  const markerNames = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "AGENTS.md", "pnpm-workspace.yaml", "turbo.json"];
  const roots = new Set<string>();
  for (const marker of markerNames) {
    if (roots.size >= maxCandidates) break;
    const result = await execFileText(ctx, "mdfind", ["-onlyin", root, `kMDItemFSName == '${marker}'`], { allowFailure: true });
    if (result.exitCode !== 0) continue;
    for (const filePath of result.stdout.split(/\r?\n/).filter(Boolean)) {
      if (roots.size >= maxCandidates) break;
      const candidateRoot = path.dirname(filePath);
      if (!isDiscoveryPathExcluded(candidateRoot, root)) {
        roots.add(candidateRoot);
      }
    }
  }
  return [...roots];
}

export function discoveryConfidence(markers: string[]): ProjectDiscoveryCandidate["confidence"] {
  if (markers.includes(".agent-workflow") || markers.includes("AGENTS.md") || markers.includes(".git")) return "high";
  if (markers.some((marker) => ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pnpm-workspace.yaml"].includes(marker))) return "medium";
  return "low";
}

export const discoveryExcludedSegments = [
  ".Trash",
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".cargo",
  ".rustup",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "target",
  "Library",
  "Applications",
  "System",
  "private",
  "dev",
  "proc",
  "tmp",
  "Backups.backupdb",
  "Photos Library.photoslibrary",
  "Music Library.musiclibrary"
];

export const discoveryMarkerFiles = [
  ".agent-workflow",
  "AGENTS.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "deno.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".git"
];

export async function ensureConfiguredRoadmapPath(projectDir: string, relativePath: string): Promise<boolean> {
  await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath, label: "roadmap_path" });
  const configPath = path.join(projectDir, ".agent-workflow", "project.yaml");
  const raw = YAML.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  const project = objectValue(raw.project);
  if (project.roadmap_path === relativePath) return false;
  project.roadmap_path = relativePath;
  raw.project = project;
  await fs.writeFile(configPath, YAML.stringify(raw), "utf8");
  return true;
}

export function formatDiscoveryAdoptionResult(result: ProjectDiscoveryAdoptionResult): string {
  const lines = [
    "Agent Workflow Discovery Adoption",
    `Generated: ${result.generatedAt}`,
    `Mode: ${result.dryRun ? "dry-run" : "write"}`,
    `Selected: ${result.selected}`,
    `Initialized: ${result.initialized}`,
    `Indexed: ${result.indexed}`,
    `Skipped: ${result.skipped}`,
    `Failed: ${result.failed}`,
    ""
  ];
  if (result.warnings.length) {
    lines.push("Warnings", ...result.warnings.map((warning) => `- ${warning}`), "");
  }
  lines.push("Items");
  if (!result.items.length) {
    lines.push("- No matching discovered candidates.");
  }
  for (const item of result.items) {
    lines.push(`- ${item.status}: ${item.rootUri}`);
    lines.push(`  actions=${item.actions.join(", ") || "none"}`);
    lines.push(`  ${item.message}`);
  }
  return lines.join("\n");
}

export function isDiscoveryPathExcluded(candidatePath: string, scanRoot?: string): boolean {
  const resolvedPath = path.resolve(candidatePath);
  const resolvedRoot = scanRoot ? path.resolve(scanRoot) : "";
  const relativePath = resolvedRoot && isPathInside(resolvedPath, resolvedRoot) ? path.relative(resolvedRoot, resolvedPath) : resolvedPath;
  const parts = relativePath.split(path.sep).filter(Boolean);
  return parts.some((part) => discoveryExcludedSegments.includes(part));
}

export function isPathInside(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function loadDashboardProjectIdentityGroups(projects: DashboardProjectSummary[]): Promise<DashboardProjectIdentityGroup[]> {
  const resolutions = await Promise.all(projects.map(async (project) => ({
    project,
    resolution: await resolveDashboardProjectPath(project.rootUri)
  })));
  const identityKeys = logicalProjectIdentityKeys(resolutions);
  const grouped = new Map<string, Array<(typeof resolutions)[number]>>();
  for (const item of resolutions) {
    const key = identityKeys.get(item) ?? item.resolution.storageRootUri;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.entries()]
    .map(([canonicalRootUri, items]) => {
      const projectsInGroup = items.map((item) => item.project);
      const latestRunAt = projectsInGroup
        .map((project) => project.lastRunAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      const preferred = items.find((item) => item.resolution.localRootUri === canonicalRootUri)?.project ?? projectsInGroup[0];
      const preferredResolution = items.find((item) => item.project === preferred)?.resolution ?? items[0].resolution;
      return {
        canonicalRootUri,
        primaryRootUri: preferred.rootUri,
        canonicalName: preferred.name,
        localPathExists: items.some((item) => item.resolution.localPathExists),
        source: preferredResolution.source,
        visibility: projectIdentityVisibility(canonicalRootUri, items.some((item) => item.resolution.localPathExists)),
        projects: projectsInGroup,
        totalRuns: projectsInGroup.reduce((sum, project) => sum + project.runCount, 0),
        totalIndexedFiles: projectsInGroup.reduce((sum, project) => sum + project.indexedFiles, 0),
        totalMemoryItems: projectsInGroup.reduce((sum, project) => sum + project.memoryItems, 0),
        activeRuns: projectsInGroup.reduce((sum, project) => sum + project.queuedRuns + project.runningRuns, 0),
        failedRuns: projectsInGroup.reduce((sum, project) => sum + project.failedRuns, 0),
        lastRunAt: latestRunAt,
        aliases: items.map((item) => ({
          rootUri: item.resolution.storageRootUri,
          mapped: item.resolution.mapped,
          source: item.resolution.source
        })).sort((left, right) => left.rootUri.localeCompare(right.rootUri))
      };
    })
    .sort((left, right) => {
      const latest = (right.lastRunAt ?? "").localeCompare(left.lastRunAt ?? "");
      return latest || right.totalRuns - left.totalRuns || left.canonicalName.localeCompare(right.canonicalName);
    });
}

export function parseSpotlightMode(value: string): SpotlightMode {
  const normalized = normalizeLookup(value);
  if (normalized === "on" || normalized === "off" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

export function plannedDiscoveryActions(candidate: ProjectDiscoveryCandidate, input: { initialize: boolean; index: boolean }): string[] {
  const actions: string[] = [];
  if (input.initialize && !candidate.initialized) {
    actions.push("initialize");
  }
  if (input.index && (candidate.initialized || input.initialize)) {
    actions.push(candidate.registered ? "refresh-index" : "register-and-index");
  }
  return actions;
}

export async function readDiscoveryMarkers(candidateRoot: string): Promise<string[]> {
  const markers: string[] = [];
  for (const marker of discoveryMarkerFiles) {
    if (await pathExists(path.join(candidateRoot, marker))) {
      markers.push(marker);
    }
  }
  return markers;
}

export function splitCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function summarizeDetectedProject(frameworks: string[], languages: string[], markers: string[]): string {
  const stack = [...frameworks, ...languages].filter(Boolean);
  if (stack.length) {
    return `Detected ${stack.join(", ")} project. Generated onboarding config should be reviewed and personalized for users, product goals, quality gates, and deployment constraints.`;
  }
  if (markers.length) {
    return `Detected project markers: ${markers.join(", ")}. Generated onboarding config should be reviewed and personalized before live workflow runs.`;
  }
  return "Generic project. Generated onboarding config should be reviewed and personalized before live workflow runs.";
}

export async function writeOnboardingFiles(ctx: CliContext, projectDir: string, result: OnboardingResult, force: boolean): Promise<{ written: string[]; skipped: string[] }> {
  const workflowDir = path.join(projectDir, ".agent-workflow");
  await fs.mkdir(workflowDir, { recursive: true });
  const roadmapFilePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: result.detected.roadmapPath, label: "roadmap_path" });
  const files = new Map<string, string>([
    [
      roadmapFilePath,
      "# Roadmap"
    ],
    [
      path.join(projectDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "This project uses Agent Workflow for reusable agent workflows, project-specific context, and safe automation.",
        "",
        "## Project Rules",
        "",
        "- Read `.agent-workflow/project.yaml` before choosing a workflow.",
        `- Use \`${result.detected.roadmapPath}\` as the source of truth for planned project work.`,
        "- Use `.agent-workflow/context.md` for product, user, team, and personalization context.",
        "- Use `.agent-workflow/commands.md` for setup, test, build, and release commands.",
        "- Use `.agent-workflow/decisions.md` for durable project decisions.",
        "- Keep reusable agents and workflows outside this project in the shared Agent Workflow repo.",
        "- Keep project-specific preferences and constraints inside this project.",
        "- Write receipts for automatic actions."
      ].join("\n")
    ],
    [
      path.join(workflowDir, "project.yaml"),
      YAML.stringify(result.config)
    ],
    [
      path.join(workflowDir, "context.md"),
      [
        `# ${result.detected.name} Context`,
        "",
        result.config.project.summary,
        "",
        "## Detected Stack",
        "",
        `- Package manager: ${result.detected.packageManager ?? "none detected"}`,
        `- Frameworks: ${result.detected.frameworks.join(", ") || "none detected"}`,
        `- Languages: ${result.detected.languages.join(", ") || "none detected"}`,
        "",
        "## Personalization Notes",
        "",
        "- Add project-specific product goals, audience, tone, architectural preferences, and reporting preferences here.",
        "- Keep durable preferences here instead of repeating them in every prompt."
      ].join("\n")
    ],
    [
      path.join(workflowDir, "commands.md"),
      [
        "# Agent Workflow Commands",
        "",
        "Recommended safe commands detected during onboarding:",
        "",
        ...result.recommendations.allowedCommands.map((command) => `- \`${command}\``)
      ].join("\n")
    ],
    [
      path.join(workflowDir, "decisions.md"),
      [
        "# Agent Workflow Decisions",
        "",
        "- Initial project configuration generated by `agentflow onboard-project`.",
        "- Update this file with durable architecture and workflow decisions."
      ].join("\n")
    ],
    [
      path.join(workflowDir, "schedules.yaml"),
      YAML.stringify({
        schedules: [
          {
            id: "weekly-context-maintenance",
            enabled: false,
            every_minutes: 10080,
            workflow: "maintain-context",
            task: "Update durable project context, decisions, and command notes.",
            index_max_files: 100,
            worker_limit: 6
          }
        ]
      })
    ]
  ]);

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [filePath, content] of files) {
    const relativePath = path.relative(projectDir, filePath);
    if (!force && await exists(filePath)) {
      skipped.push(relativePath);
      continue;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${content.replace(/\n+$/u, "")}\n`, "utf8");
    written.push(relativePath);
  }
  const configUpdated = await ensureConfiguredRoadmapPath(projectDir, result.detected.roadmapPath);
  const configRelativePath = path.join(".agent-workflow", "project.yaml");
  if (configUpdated && !written.includes(configRelativePath)) {
    const skippedIndex = skipped.indexOf(configRelativePath);
    if (skippedIndex >= 0) skipped.splice(skippedIndex, 1);
    written.push(configRelativePath);
  }
  const bundleState = await writeProjectBundleState(ctx, projectDir, force);
  if (bundleState.status === "written") {
    written.push(bundleState.relativePath);
  } else {
    skipped.push(bundleState.relativePath);
  }
  return { written, skipped };
}
