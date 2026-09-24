import { byId } from "../../../packages/agent-registry/src/loaders.js";

const workflowAliases: Record<string, string> = {
  "review-change": "review-pr",
  review: "review-pr",
  "pull-request-review": "review-pr",
  "fix-failure": "debug-failure",
  debug: "debug-failure",
  investigate: "investigate-issue",
  diagnose: "investigate-issue",
  release: "ship-release",
  ship: "ship-release",
  "context-maintenance": "maintain-context",
  "update-context": "maintain-context"
};

const agentAliases: Record<string, string> = {
  mira: "ux-reviewer",
  ux: "ux-reviewer",
  "ux-pass": "ux-reviewer",
  "ux-review": "ux-reviewer",
  frontend: "frontend-engineer",
  backend: "backend-engineer",
  database: "database-engineer",
  db: "database-engineer",
  security: "security-reviewer",
  test: "test-engineer",
  tests: "test-engineer",
  ci: "ci-debugger",
  docs: "docs-maintainer",
  release: "release-manager",
  product: "product-strategist",
  architect: "technical-architect",
  architecture: "technical-architect"
};

const providerAliases: Record<string, string> = {
  auto: "auto",
  automatic: "auto",
  smart: "auto",
  router: "auto",
  "auto-router": "auto",
  openai: "openai",
  "open-ai": "openai",
  gpt: "openai",
  codex: "codex-cli",
  "codex-cli": "codex-cli",
  kiro: "kiro",
  anthropic: "anthropic",
  claude: "anthropic",
  muse: "muse",
  byo: "byo",
  "bring-your-own": "byo",
  "bring-your-own-model": "byo",
  "byo-model": "byo",
  mock: "mock",
  test: "mock",
  local: "local",
  localhost: "local",
  ollama: "local",
  "lm-studio": "local",
  lmstudio: "local",
  llama: "local",
  "llama-cpp": "local",
  "openai-compatible": "openai-compatible",
  "open-ai-compatible": "openai-compatible",
  compatible: "openai-compatible",
  bedrock: "bedrock",
  aws: "bedrock"
};

export function resolveWorkflow<T extends { id: string }>(workflows: T[], workflowId: string): T | undefined {
  return byId(workflows).get(workflowAliases[workflowId] ?? workflowId);
}

export function resolveAgent<T extends { id: string; display_name: string }>(agents: T[], agentRef: string): T | undefined {
  const normalizedRef = normalizeLookup(agentRef);
  const resolvedId = agentAliases[normalizedRef] ?? agentRef;
  const agentIndex = byId(agents);
  return agentIndex.get(resolvedId)
    ?? agents.find((agent) => normalizeLookup(agent.display_name) === normalizedRef)
    ?? agents.find((agent) => normalizeLookup(agent.id) === normalizedRef);
}

export function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function normalizeProviderRef(value: string): string {
  const normalized = normalizeLookup(value);
  return providerAliases[normalized] ?? normalized;
}
