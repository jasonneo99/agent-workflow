import { createHash } from "node:crypto";
import {
  workflowSchema,
  type AgentCard,
  type ProjectConfig,
  type WorkflowDefinition
} from "../../agent-registry/src/schemas.js";

export type StageTemplate = {
  id: string;
  agent: string;
  goal: string;
  pattern: "planner" | "executor" | "verifier" | "reflexive" | "finalizer";
  output: string;
  contextTokens: number;
  acceptanceCriteria: string[];
  modelTier: "fast" | "standard" | "reasoning";
  approval?: boolean;
};

export const stageTemplates: Record<string, StageTemplate> = {
  triage: stage("triage", "task-triager", "Classify the goal, constraints, and relevant project context.", "planner", "task_triage", 2500, ["Scope and constraints are explicit"], "fast"),
  architecture: stage("architecture", "technical-architect", "Design the smallest coherent implementation approach.", "planner", "implementation_plan", 5000, ["Plan names boundaries, risks, and verification"], "reasoning"),
  ux: stage("ux", "ux-reviewer", "Specify and review the user experience and accessibility contract.", "planner", "ux_contract", 3500, ["Primary flows and accessibility expectations are explicit"], "standard"),
  database: stage("database", "database-engineer", "Design data changes, compatibility, and rollback.", "planner", "data_plan", 4500, ["Migration and rollback behavior are explicit"], "reasoning"),
  security: stage("security", "security-reviewer", "Review trust boundaries, authorization, secrets, and abuse cases.", "verifier", "security_review", 4500, ["Material threats have mitigations or accepted risk"], "reasoning"),
  implement: stage("implement", "implementation-agent", "Implement the completed plan under project policy. Do not invent a separate plan-promotion approval; block only on an actual open approval, an explicit approval-required stage, or a concrete policy denial.", "executor", "change_summary", 8000, ["Requested behavior is implemented", "No action exceeds project policy"], "standard"),
  frontend: stage("frontend", "frontend-engineer", "Implement the frontend portion and interaction states.", "executor", "frontend_change", 6500, ["UI behavior matches the UX contract"], "standard"),
  backend: stage("backend", "backend-engineer", "Implement APIs, services, jobs, and integrations.", "executor", "backend_change", 6500, ["Service contracts and failure behavior are covered"], "standard"),
  integrate: stage("integrate", "implementation-agent", "Integrate parallel work-item results, reconcile overlaps, and preserve the combined acceptance contract.", "executor", "integration_summary", 6000, ["Parallel results are reconciled without dropping completed behavior", "Overlaps and residual conflicts are explicit"], "standard"),
  test: stage("test", "test-engineer", "Add focused coverage for the changed behavior.", "verifier", "test_evidence", 4500, ["Happy path and material failure paths are tested"], "standard"),
  verify: stage("verify", "auto-test-runner", "Run configured deterministic verification and report exact evidence.", "verifier", "verification_report", 4000, ["Required checks pass or failures are explained"], "fast"),
  docs: stage("docs", "docs-maintainer", "Update user and operator documentation for the change.", "reflexive", "documentation_update", 3500, ["Changed behavior and operating steps are documented"], "fast"),
  release: stage("release", "release-manager", "Assess release readiness, rollback, and approval evidence.", "finalizer", "release_decision", 3500, ["Go/no-go and rollback evidence are explicit"], "reasoning", true),
  package: stage("package", "pr-preparer", "Package changes, test evidence, risks, and follow-ups for review.", "finalizer", "review_package", 3000, ["Review package links changes, evidence, and residual risks"], "fast", true),
  diagnose: stage("diagnose", "ci-debugger", "Reproduce the failure and identify an evidence-backed root cause.", "planner", "diagnosis", 5000, ["Root cause explains the observed failure"], "reasoning"),
  evaluate: stage("evaluate", "eval-curator", "Create or update scrubbed evaluation coverage for observed behavior.", "verifier", "evaluation_set", 4000, ["Evaluation cases are representative and scrubbed"], "standard")
};

export type WorkflowArchetype = { id: string; description: string; keywords: string[]; stages: string[] };

export const workflowArchetypes: WorkflowArchetype[] = [
  archetype("web-app", "Build a local or hosted web application.", ["web app", "website", "frontend", "dashboard", "ui"], ["triage", "architecture", "ux", "frontend", "backend", "test", "verify", "security", "docs", "package"]),
  archetype("api-service", "Build or change an API or backend service.", ["api", "service", "endpoint", "backend", "webhook"], ["triage", "architecture", "backend", "test", "security", "verify", "docs", "package"]),
  archetype("data-migration", "Change schemas or migrate persistent data.", ["migration", "schema", "database", "postgres", "data"], ["triage", "database", "architecture", "implement", "test", "verify", "security", "release"]),
  archetype("debug-failure", "Diagnose and fix a reproducible failure.", ["bug", "failure", "broken", "debug", "fix"], ["triage", "diagnose", "implement", "test", "verify", "package"]),
  archetype("security-hardening", "Review and harden a security boundary.", ["security", "vulnerability", "auth", "permission", "threat"], ["triage", "security", "architecture", "implement", "test", "verify", "security", "package"]),
  archetype("release", "Prepare and validate a release.", ["release", "ship", "deploy", "publish", "launch"], ["triage", "verify", "security", "docs", "release"]),
  archetype("code-review", "Review a proposed code change.", ["review", "pull request", "pr", "diff", "audit"], ["triage", "architecture", "security", "test", "package"]),
  archetype("documentation", "Create or maintain technical documentation.", ["documentation", "docs", "guide", "readme", "tutorial"], ["triage", "architecture", "docs", "verify", "package"]),
  archetype("model-improvement", "Improve prompts, routing, context, or evaluations.", ["model", "prompt", "routing", "eval", "fine tuning"], ["triage", "diagnose", "evaluate", "architecture", "implement", "verify", "package"]),
  archetype("maintenance", "Refactor or perform general repository maintenance.", ["refactor", "maintenance", "cleanup", "upgrade", "dependency"], ["triage", "architecture", "implement", "test", "verify", "docs", "package"]),
  archetype("feature-delivery", "Implement and verify a general product or repository change.", ["implement", "add", "create", "change", "update"], ["triage", "architecture", "implement", "test", "verify", "package"]),
  archetype("product-discovery", "Turn a product goal into an implementation-ready direction.", ["research", "product", "strategy", "prototype", "discovery"], ["triage", "ux", "architecture", "security", "package"])
];

export type DynamicPlanChanges = {
  add?: Array<{ template: string; after?: string }>;
  remove?: string[];
  repeat?: Array<{ stage: string; count: number }>;
  order?: string[];
  parallel?: string[][];
  providerBindings?: Record<string, string>;
  modelTierBindings?: Record<string, "fast" | "standard" | "reasoning">;
  contextBudgets?: Record<string, number>;
  approvalStages?: string[];
  workItems?: string[];
};

export type ConstructDynamicWorkflowInput = {
  goal: string;
  project: ProjectConfig;
  agents?: AgentCard[];
  changes?: DynamicPlanChanges;
  executionProfile?: "full" | "adaptive";
  now?: string;
};

export type AdaptiveExecutionPlan = {
  complexity: "simple" | "medium" | "complex";
  latencyBudgetMs: number;
  targetDirectRatio: number;
  changes: DynamicPlanChanges;
  rationale: string[];
};

const HIGH_RISK_GOAL = /\b(?:auth(?:entication|orization)?|permission|security|vulnerability|migration|schema|database|deploy|release|payment|billing|secret|credential|production)\b/iu;
const BROAD_SCOPE_GOAL = /\b(?:cohesive|across|end[- ]to[- ]end|multiple|all|roadmap|platform|architecture|frontend|backend)\b/iu;

export function recommendAdaptiveExecution(goal: string, archetype = selectWorkflowArchetype(goal)): AdaptiveExecutionPlan {
  const words = goal.trim().split(/\s+/u).filter(Boolean).length;
  const highRisk = HIGH_RISK_GOAL.test(goal);
  const broad = BROAD_SCOPE_GOAL.test(goal) || (goal.match(/[;:]/gu)?.length ?? 0) > 1;
  const enumeratedWorkItems = extractEnumeratedWorkItems(goal);
  const complexity: AdaptiveExecutionPlan["complexity"] = enumeratedWorkItems.length > 1 || highRisk || words > 90 || broad && words > 45
    ? "complex"
    : words <= 24 && !broad
      ? "simple"
      : "medium";
  const stages = new Set(archetype.stages);
  const remove: string[] = [];
  const parallel: string[][] = [];
  const workItems = complexity === "complex" ? enumeratedWorkItems : [];

  if (complexity === "simple") {
    const preferredExecutor = /\b(?:api|backend|service|endpoint|webhook)\b/iu.test(goal) ? "backend" : "frontend";
    const essentialsByArchetype: Record<string, string[]> = {
      "web-app": [preferredExecutor, "verify"],
      "api-service": ["backend", "verify"],
      "debug-failure": ["diagnose", "implement", "verify"],
      documentation: ["docs", "verify"],
      maintenance: ["implement", "verify"],
      "feature-delivery": ["implement", "verify"],
      "code-review": ["architecture", "test"],
      "product-discovery": ["ux", "architecture", "security"]
    };
    const essentials = new Set(essentialsByArchetype[archetype.id] ?? ["implement", "verify"]);
    for (const stage of archetype.stages) {
      if (!essentials.has(stage)) remove.push(stage);
    }
  } else {
    if (stages.has("triage")) remove.push("triage");
    if (stages.has("docs") && archetype.id !== "documentation") remove.push("docs");
    if (stages.has("package") && complexity === "medium") remove.push("package");
    if (stages.has("frontend") && stages.has("backend")) parallel.push(["frontend", "backend"]);
  }

  return {
    complexity,
    latencyBudgetMs: complexity === "simple" ? 90_000 : complexity === "medium" ? 240_000 : 480_000,
    targetDirectRatio: complexity === "simple" ? 1.2 : complexity === "medium" ? 1.5 : 2,
    changes: { remove: [...new Set(remove)], ...(parallel.length ? { parallel } : {}), ...(workItems.length > 1 ? { workItems } : {}) },
    rationale: [
      `Classified the goal as ${complexity} from scope, risk, and length signals.`,
      complexity === "simple" ? "Selected one owning execution stage plus deterministic verification." : "Removed redundant triage/documentation ceremony while preserving implementation and verification.",
      workItems.length > 1
        ? `Decomposed ${workItems.length} bounded work items into parallel implementation branches behind an integration join.`
        : parallel.length
          ? `Parallelized independent branches: ${parallel.map((group) => group.join(" + ")).join(", ")}.`
          : "Kept dependency order because no safe parallel branch was identified."
    ]
  };
}

export function selectWorkflowArchetype(goal: string): WorkflowArchetype {
  const normalized = goal.toLowerCase();
  const mutationIntent = /^\s*(?:implement|add|create|change|update|build|fix|remove|delete|write)\b/iu.test(goal);
  return workflowArchetypes
    .map((candidate, index) => ({
      candidate,
      index,
      // A mutation request can legitimately mention review cards, review
      // feedback, or audit UI without asking for a read-only code review.
      // Preserve explicit review routing while preventing that incidental noun
      // from stripping the generated workflow of its executor stage.
      score: mutationIntent && candidate.id === "code-review"
        ? 0
        : candidate.keywords.reduce((score, keyword) => score + (normalized.includes(keyword) ? keyword.split(/\s+/).length : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].candidate;
}

export function constructDynamicWorkflow(input: ConstructDynamicWorkflowInput): WorkflowDefinition {
  if (!input.goal.trim()) throw new Error("Dynamic workflow goal must not be empty.");
  const selected = selectWorkflowArchetype(input.goal);
  const executionProfile = input.executionProfile ?? "full";
  const adaptive = executionProfile === "adaptive" ? recommendAdaptiveExecution(input.goal, selected) : null;
  const changes = mergePlanChanges(adaptive?.changes, input.changes);
  let templateIds = [...selected.stages];
  for (const requested of changes.remove ?? []) {
    if (requested === "verify" || requested === "security" && selected.id === "security-hardening") {
      throw new Error(`Mandatory stage '${requested}' cannot be removed.`);
    }
    templateIds = templateIds.filter((id) => id !== requested);
  }
  for (const addition of changes.add ?? []) {
    requireTemplate(addition.template);
    const index = addition.after ? templateIds.lastIndexOf(addition.after) + 1 : templateIds.length;
    templateIds.splice(index > 0 ? index : templateIds.length, 0, addition.template);
  }
  for (const repetition of changes.repeat ?? []) {
    const index = templateIds.indexOf(repetition.stage);
    if (index < 0 || repetition.count < 2 || repetition.count > 5) throw new Error(`Invalid repeat request for '${repetition.stage}'.`);
    templateIds.splice(index + 1, 0, ...Array.from({ length: repetition.count - 1 }, () => repetition.stage));
  }
  if (changes.order) {
    if (!sameMultiset(changes.order, templateIds)) throw new Error("Explicit stage order must contain every generated stage exactly once.");
    templateIds = [...changes.order];
  }

  const occurrences = new Map<string, number>();
  const stages = templateIds.map((templateId, index) => {
    const template = requireTemplate(templateId);
    const occurrence = (occurrences.get(templateId) ?? 0) + 1;
    occurrences.set(templateId, occurrence);
    const id = occurrence === 1 ? templateId : `${templateId}-${occurrence}`;
    const parallelGroup = (changes.parallel ?? []).findIndex((group) => group.includes(id));
    const previous = index === 0 ? [] : [stageIdAt(templateIds, index - 1)];
    return {
      id,
      agent: template.agent,
      goal: template.goal,
      subagents: [],
      depends_on: parallelGroup >= 0 ? parallelDependencies(templateIds, index, changes.parallel![parallelGroup]) : previous,
      ...(parallelGroup >= 0 ? { parallel_group: `parallel-${parallelGroup + 1}` } : {}),
      acceptance_criteria: template.acceptanceCriteria,
      routing: {
        provider: changes.providerBindings?.[id] ?? "default",
        model_tier: changes.modelTierBindings?.[id] ?? template.modelTier
      },
      pattern: {
        type: template.pattern,
        requires_verifier: template.pattern === "executor",
        promotion_gate: template.approval || changes.approvalStages?.includes(id) ? "approval" as const : template.pattern === "verifier" ? "evaluation" as const : template.pattern === "executor" ? "policy" as const : "none" as const,
        stop_conditions: []
      },
      context: { load: ["project_contract", ...(previous.length ? ["prior_stage_outputs"] : [])], max_tokens: clampBudget(changes.contextBudgets?.[id] ?? template.contextTokens, input.project.context.max_project_tokens) },
      approval_required: Boolean(template.approval || changes.approvalStages?.includes(id) || input.project.policies.require_approval_for_external_actions && ["release", "package"].includes(templateId)),
      output: template.output
    };
  });
  const boundedWorkItems = (changes.workItems ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  const implementationIndex = stages.findIndex((stage) => stage.id === "implement");
  if (boundedWorkItems.length > 1 && implementationIndex >= 0) {
    const implementation = stages[implementationIndex];
    const branchIds = boundedWorkItems.map((_item, index) => `implement-item-${index + 1}`);
    const branches = boundedWorkItems.map((item, index) => ({
      ...structuredClone(implementation),
      id: branchIds[index],
      goal: `Implement bounded work item ${index + 1} of ${boundedWorkItems.length}: ${item}`,
      depends_on: [...(implementation.depends_on ?? [])],
      parallel_group: "parallel-work-items",
      acceptance_criteria: [...implementation.acceptance_criteria, `Work item ${index + 1} remains within its declared scope`]
    }));
    const integrationTemplate = requireTemplate("integrate");
    const integration = {
      id: "integrate",
      agent: integrationTemplate.agent,
      goal: integrationTemplate.goal,
      subagents: [],
      depends_on: branchIds,
      acceptance_criteria: integrationTemplate.acceptanceCriteria,
      routing: { provider: changes.providerBindings?.integrate ?? "default", model_tier: changes.modelTierBindings?.integrate ?? integrationTemplate.modelTier },
      pattern: { type: integrationTemplate.pattern, requires_verifier: true, promotion_gate: "policy" as const, stop_conditions: [] },
      context: { load: ["project_contract", "prior_stage_outputs"], max_tokens: clampBudget(changes.contextBudgets?.integrate ?? integrationTemplate.contextTokens, input.project.context.max_project_tokens) },
      approval_required: Boolean(changes.approvalStages?.includes("integrate")),
      output: integrationTemplate.output
    };
    stages.splice(implementationIndex, 1, ...branches, integration);
    for (const stage of stages) {
      if (stage.id !== "integrate" && stage.depends_on?.includes("implement")) {
        stage.depends_on = stage.depends_on.flatMap((dependency) => dependency === "implement" ? ["integrate"] : [dependency]);
      }
    }
  }
  // A stage after a parallel block is a real join: it cannot run after only the
  // last textual branch happens to finish.
  for (let index = 1; index < stages.length; index += 1) {
    const previousGroup = stages[index - 1].parallel_group;
    if (!stages[index].parallel_group && previousGroup) {
      stages[index].depends_on = stages.filter((item) => item.parallel_group === previousGroup).map((item) => item.id);
    }
  }
  const agentIds = input.agents ? new Set(input.agents.map((agent) => agent.id)) : undefined;
  if (agentIds) {
    for (const item of stages) if (!agentIds.has(item.agent)) throw new Error(`Dynamic stage '${item.id}' references unknown agent '${item.agent}'.`);
  }

  const policyHash = sha256(stableJson({ policies: input.project.policies, actions: input.project.actions, profile: input.project.execution.policy_profile }));
  const controls = ["project-action-allowlists", "destructive-action-boundary"];
  if (input.project.policies.require_receipts) controls.push("receipts-required");
  if (input.project.policies.require_approval_for_external_actions) controls.push("external-actions-require-approval");
  const generatedAt = input.now ?? new Date().toISOString();
  const draft = {
    id: `dynamic-${selected.id}-${sha256(input.goal).slice(0, 12)}`,
    name: `Dynamic ${selected.id}`,
    description: `Runtime workflow generated for: ${input.goal}`,
    lead: "workflow-orchestrator",
    default_autonomy: input.project.project.autonomy,
    triggers: { manual: true, events: [] as string[] },
    dynamic: {
      schema_version: 1 as const,
      archetype: selected.id,
      version: 1,
      definition_hash: "0".repeat(64),
      goal: input.goal.trim(),
      construction_rationale: [`Selected '${selected.id}' from goal keyword evidence.`, ...(adaptive?.rationale ?? []), `Applied ${stages.length} validated stage bindings.`, "Inherited mandatory project policy controls without modification."],
      generated_at: generatedAt,
      policy_hash: policyHash,
      mandatory_controls: controls,
      execution_profile: executionProfile,
      ...(adaptive ? { complexity: adaptive.complexity, latency_budget_ms: adaptive.latencyBudgetMs, target_direct_ratio: adaptive.targetDirectRatio } : {})
    },
    stages
  };
  draft.dynamic.definition_hash = definitionHash(draft);
  return validateDynamicWorkflow(draft, input.project);
}

export function validateDynamicWorkflow(value: unknown, project: ProjectConfig): WorkflowDefinition {
  const workflow = workflowSchema.parse(value);
  if (!workflow.dynamic) throw new Error("Dynamic workflow metadata is required.");
  if (workflow.dynamic.definition_hash !== definitionHash(workflow)) throw new Error("Dynamic workflow definition hash does not match its content.");
  const expectedPolicyHash = sha256(stableJson({ policies: project.policies, actions: project.actions, profile: project.execution.policy_profile }));
  if (workflow.dynamic.policy_hash !== expectedPolicyHash) throw new Error("Dynamic workflow policy snapshot does not match the project policy.");
  const ids = new Set(workflow.stages.map((item) => item.id));
  if (ids.size !== workflow.stages.length) throw new Error("Dynamic workflow stage ids must be unique.");
  for (const item of workflow.stages) {
    if ((item.depends_on ?? []).some((dependency) => !ids.has(dependency) || dependency === item.id)) throw new Error(`Stage '${item.id}' has an invalid dependency.`);
  }
  assertAcyclic(workflow);
  if (!workflow.stages.some((item) => item.pattern.type === "verifier")) throw new Error("Dynamic workflows require a verification stage.");
  return workflow;
}

export function definitionHash(workflow: unknown): string {
  const clone = structuredClone(workflow) as { dynamic?: { definition_hash?: string } };
  if (clone.dynamic) clone.dynamic.definition_hash = "";
  return sha256(stableJson(clone));
}

function stage(id: string, agent: string, goal: string, pattern: StageTemplate["pattern"], output: string, contextTokens: number, acceptanceCriteria: string[], modelTier: StageTemplate["modelTier"], approval = false): StageTemplate {
  return { id, agent, goal, pattern, output, contextTokens, acceptanceCriteria, modelTier, approval };
}
function archetype(id: string, description: string, keywords: string[], stages: string[]): WorkflowArchetype { return { id, description, keywords, stages }; }
function requireTemplate(id: string): StageTemplate { const found = stageTemplates[id]; if (!found) throw new Error(`Unknown stage template '${id}'.`); return found; }
function clampBudget(value: number, projectMax: number): number { return Math.max(256, Math.min(Math.floor(value), projectMax)); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)])); return value; }
function sameMultiset(left: string[], right: string[]): boolean { return [...left].sort().join("\0") === [...right].sort().join("\0"); }
function stageIdAt(ids: string[], index: number): string { const id = ids[index]; const occurrence = ids.slice(0, index + 1).filter((item) => item === id).length; return occurrence === 1 ? id : `${id}-${occurrence}`; }
function parallelDependencies(ids: string[], index: number, group: string[]): string[] { const firstIndex = Math.min(...group.map((id) => ids.findIndex((_template, candidateIndex) => stageIdAt(ids, candidateIndex) === id)).filter((item) => item >= 0)); return firstIndex <= 0 || index < firstIndex ? [] : [stageIdAt(ids, firstIndex - 1)]; }
function mergePlanChanges(base: DynamicPlanChanges | undefined, override: DynamicPlanChanges | undefined): DynamicPlanChanges {
  if (!base) return override ?? {};
  if (!override) return base;
  return {
    ...base,
    ...override,
    add: [...(base.add ?? []), ...(override.add ?? [])],
    remove: [...new Set([...(base.remove ?? []), ...(override.remove ?? [])])],
    parallel: override.parallel ?? base.parallel
  };
}
export function extractEnumeratedWorkItems(goal: string): string[] {
  const marker = /(?:^|[;\n\s])\((\d{1,2})\)\s*/gu;
  const markers = [...goal.matchAll(marker)];
  if (markers.length < 2) return [];
  const ordered = markers
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = markers[index + 1]?.index ?? goal.length;
      return { number: Number(match[1]), text: goal.slice(start, end).trim().replace(/[;,.]+$/u, "") };
    })
    .filter((item) => item.number > 0 && item.text.length >= 3 && item.text.length <= 500)
    .sort((left, right) => left.number - right.number);
  return ordered.length >= 2 ? ordered.slice(0, 12).map((item) => item.text) : [];
}
function assertAcyclic(workflow: WorkflowDefinition): void {
  const dependencies = new Map(workflow.stages.map((stage) => [stage.id, stage.depends_on ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Dynamic workflow contains a dependency cycle at '${id}'.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}
