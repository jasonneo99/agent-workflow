export type OrchestrationStep = {
  id: string;
  title: string;
  reason: string;
  kind: "agent" | "workflow" | "preset";
  target: string;
  task: string;
  adaptive?: boolean;
  skipIfPriorEmpty?: boolean;
};

export type OrchestrationPlan = {
  projectDir: string;
  task: string;
  executionProfile: "adaptive" | "full";
  steps: OrchestrationStep[];
};

export function createOrchestrationPlan(input: { projectDir: string; task: string; executionProfile?: "adaptive" | "full" }): OrchestrationPlan {
  const executionProfile = input.executionProfile ?? "adaptive";
  const normalizedTask = normalizeLookup(input.task);
  const steps: OrchestrationStep[] = [];
  const addStep = (step: Omit<OrchestrationStep, "id">): void => {
    const duplicate = steps.some((existing) => existing.kind === step.kind && existing.target === step.target);
    if (!duplicate) steps.push({ ...step, id: `step-${steps.length + 1}` });
  };
  const includesAny = (terms: string[]): boolean => terms.some((term) => normalizedTask.includes(normalizeLookup(term)));
  const requestsMutation = includesAny(["implement", "fix", "add", "build", "change", "update", "create", "remove", "delete", "write"]);
  const asksProjectQuestion = !requestsMutation && (
    /^(?:what|which|where|when|who|how|show|list|tell|summarize|summarise)\b/u.test(normalizedTask)
    || includesAny(["roadmap", "next items", "next tasks", "project status", "current status", "what is next", "what's next"])
  );

  if (asksProjectQuestion) {
    addStep({
      title: "Project question",
      reason: "The request asks for read-only project information, so use one context-aware specialist instead of a multi-stage review.",
      kind: "agent",
      target: "technical-architect",
      task: `Inspect the project's durable context and relevant source files, then answer this question directly without making changes: ${input.task}`
    });
    return { projectDir: input.projectDir, task: input.task, executionProfile, steps };
  }

  if (executionProfile === "adaptive") {
    const failure = includesAny(["test", "tests", "failing", "failure", "bug", "error", "ci", "build failed", "broken", "fix", "repair", "resolve"]);
    const documentation = includesAny(["docs", "documentation", "readme", "guide", "tutorial"]);
    const review = !requestsMutation || includesAny(["review", "audit", "inspect", "analyze", "analyse"]);
    const target = failure ? "debug-failure" : documentation ? "maintain-context" : review ? "review-pr" : "build-feature";
    addStep({
      title: failure ? "Adaptive diagnosis and repair" : documentation ? "Adaptive documentation update" : review ? "Adaptive project review" : "Adaptive implementation",
      reason: "Codex uses one risk-scaled workflow graph so specialists do not repeat the same discovery and review work.",
      kind: "workflow",
      target,
      task: input.task,
      adaptive: true
    });
    return { projectDir: input.projectDir, task: input.task, executionProfile, steps };
  }

  if (includesAny(["ux", "user experience", "design", "layout", "visual", "accessibility", "mobile", "responsive", "conversion", "onboarding", "homepage"])) {
    addStep({ title: "UX review", reason: "The request touches user experience, visual quality, conversion, accessibility, or responsive behavior.", kind: "agent", target: "Mira", task: `Review UX for this request and produce prioritized findings: ${input.task}` });
  }
  if (includesAny(["frontend", "ui", "css", "html", "javascript", "component", "page", "site", "mobile", "responsive", "layout"])) {
    addStep({ title: "Frontend implementation review", reason: "The request likely involves browser-facing code or static site implementation details.", kind: "agent", target: "frontend", task: `Review frontend implementation needs, risks, and concrete fixes for: ${input.task}` });
  }
  if (includesAny(["security", "auth", "permission", "secret", "xss", "production", "wordpress", "external"])) {
    addStep({ title: "Security and production risk review", reason: "The request mentions production, external systems, WordPress, or security-sensitive areas.", kind: "agent", target: "security", task: `Review security and production risks for: ${input.task}` });
  }
  if (includesAny(["test", "tests", "failing", "failure", "bug", "error", "ci", "build failed", "broken"])) {
    const requestsRepair = includesAny(["fix", "implement", "repair", "patch", "resolve"]);
    const requestsInvestigationOnly = includesAny(["read-only", "investigate", "audit", "diagnose", "analyze", "analyse", "inspect", "validate"]);
    addStep({
      title: requestsInvestigationOnly && !requestsRepair ? "Issue investigation" : "Failure diagnosis and repair",
      reason: requestsInvestigationOnly && !requestsRepair ? "The request asks for investigation without authorizing a repair." : "The request identifies a failure and asks for diagnosis or repair.",
      kind: "workflow",
      target: requestsInvestigationOnly && !requestsRepair ? "investigate-issue" : "debug-failure",
      task: requestsInvestigationOnly && !requestsRepair ? `Investigate and classify the issue without making changes: ${input.task}` : `Diagnose, fix, and verify the confirmed failure: ${input.task}`
    });
  }
  if (includesAny(["review", "audit", "risk", "production", "deploy", "launch", "ship", "seo", "content", "site"])) {
    addStep({ title: "Change review", reason: "The request calls for review, launch readiness, production confidence, SEO, or site-wide risk assessment.", kind: "workflow", target: "review-pr", task: `Review the project for risks, regressions, missing checks, and recommended actions related to: ${input.task}`, skipIfPriorEmpty: true });
  }
  if (requestsMutation && !includesAny(["review", "audit", "pass"])) {
    const pinnedBuild = /\bbuild\b/u.test(normalizedTask);
    addStep({
      title: pinnedBuild ? "Build and deliver product" : "Feature implementation",
      reason: pinnedBuild
        ? "BUILD is a pinned delivery keyword: create, verify, package, and deliver a usable product within policy."
        : "The request asks for implementation or changes, so the build-feature workflow should execute within policy.",
      kind: "workflow",
      target: "build-feature",
      task: pinnedBuild
        ? `BUILD CONTRACT: Create, verify, package, and deliver the requested usable product. Analysis, planning, documentation, or handoff alone is not completion. Original request: ${input.task}`
        : `Implement and verify the requested change within project policy: ${input.task}`
    });
  }
  if (includesAny(["context", "memory", "docs", "documentation", "remember", "decisions"])) {
    addStep({ title: "Context maintenance", reason: "The request mentions durable memory, docs, context, or decisions.", kind: "workflow", target: "maintain-context", task: `Update durable project context and decisions for: ${input.task}` });
  }
  if (!steps.length) {
    addStep({ title: "General project review", reason: "No narrow route matched, so start with a conservative project review.", kind: "workflow", target: "review-pr", task: `Review and recommend the next action for: ${input.task}` });
  }
  return { projectDir: input.projectDir, task: input.task, executionProfile, steps };
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}
