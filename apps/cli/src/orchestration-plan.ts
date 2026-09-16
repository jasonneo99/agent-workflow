export type OrchestrationStep = {
  id: string;
  title: string;
  reason: string;
  kind: "agent" | "workflow" | "preset";
  target: string;
  task: string;
  skipIfPriorEmpty?: boolean;
};

export type OrchestrationPlan = {
  projectDir: string;
  task: string;
  steps: OrchestrationStep[];
};

export function createOrchestrationPlan(input: { projectDir: string; task: string }): OrchestrationPlan {
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
    return { projectDir: input.projectDir, task: input.task, steps };
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
    addStep({ title: "Feature implementation plan", reason: "The request asks for implementation or changes, so the build-feature workflow should plan and execute within policy.", kind: "workflow", target: "build-feature", task: `Implement or plan the requested change within project policy: ${input.task}` });
  }
  if (includesAny(["context", "memory", "docs", "documentation", "remember", "decisions"])) {
    addStep({ title: "Context maintenance", reason: "The request mentions durable memory, docs, context, or decisions.", kind: "workflow", target: "maintain-context", task: `Update durable project context and decisions for: ${input.task}` });
  }
  if (!steps.length) {
    addStep({ title: "General project review", reason: "No narrow route matched, so start with a conservative project review.", kind: "workflow", target: "review-pr", task: `Review and recommend the next action for: ${input.task}` });
  }
  return { projectDir: input.projectDir, task: input.task, steps };
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}
