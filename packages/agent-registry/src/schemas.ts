import { z } from "zod";

export const autonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal("wide-open")
]);

export const agentCardSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  category: z.enum(["core", "development", "product", "operations", "automatic"]),
  purpose: z.string().min(1),
  model_strategy: z.string().default("provider-agnostic"),
  model_tier: z.enum(["fast", "standard", "reasoning"]).default("standard"),
  autonomy: autonomyLevelSchema.default(1),
  use_when: z.array(z.string()).default([]),
  avoid_when: z.array(z.string()).default([]),
  can: z.array(z.string()).default([]),
  cannot: z.array(z.string()).default([]),
  requires_approval: z.array(z.string()).default([]),
  context_budget: z.object({
    max_tokens: z.number().int().positive().default(2500),
    preferred_sources: z.array(z.string()).default([])
  }).default({ max_tokens: 2500, preferred_sources: [] }),
  outputs: z.object({
    schema: z.string().default("structured_summary")
  }).default({ schema: "structured_summary" }),
  prompt: z.string().min(1)
});

export type AgentCard = z.infer<typeof agentCardSchema>;

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  lead: z.string().min(1),
  default_autonomy: autonomyLevelSchema.default(2),
  triggers: z.object({
    manual: z.boolean().default(true),
    schedule: z.string().optional(),
    events: z.array(z.string()).default([])
  }).default({ manual: true, events: [] }),
  stages: z.array(z.object({
    id: z.string().min(1),
    agent: z.string().min(1),
    goal: z.string().min(1),
    subagents: z.array(z.string()).default([]),
    context: z.object({
      load: z.array(z.string()).default([]),
      max_tokens: z.number().int().positive().default(4000)
    }).default({ load: [], max_tokens: 4000 }),
    approval_required: z.boolean().default(false),
    output: z.string().default("structured_summary")
  })).min(1)
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;

const policyOverridesSchema = z.object({
  allow_wide_open: z.boolean().optional(),
  require_approval_for_external_actions: z.boolean().optional(),
  require_receipts: z.boolean().optional()
}).default({});

const actionOverridesSchema = z.object({
  allowed_commands: z.array(z.string()).optional(),
  blocked_commands: z.array(z.string()).optional(),
  command_timeout_ms: z.number().int().positive().optional(),
  max_output_chars: z.number().int().positive().optional(),
  allowed_write_paths: z.array(z.string()).optional(),
  blocked_write_paths: z.array(z.string()).optional(),
  max_write_bytes: z.number().int().positive().optional()
}).default({});

export const executionPolicyProfileSchema = z.object({
  autonomy: autonomyLevelSchema.optional(),
  policies: policyOverridesSchema,
  actions: actionOverridesSchema
});

export type ExecutionPolicyProfile = z.infer<typeof executionPolicyProfileSchema>;

export const projectConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    summary: z.string().default(""),
    default_workflows: z.array(z.string()).default([]),
    autonomy: autonomyLevelSchema.default(2)
  }),
  context: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default(["node_modules/**", ".git/**", "dist/**"]),
    max_project_tokens: z.number().int().positive().default(12000)
  }).default({ include: [], exclude: ["node_modules/**", ".git/**", "dist/**"], max_project_tokens: 12000 }),
  storage: z.object({
    cache_summaries: z.boolean().default(true),
    semantic_index: z.boolean().default(true)
  }).default({ cache_summaries: true, semantic_index: true }),
  execution: z.object({
    policy_profile: z.string().min(1).default("local"),
    policy_profiles: z.record(z.string(), executionPolicyProfileSchema).default({})
  }).default({ policy_profile: "local", policy_profiles: {} }),
  policies: z.object({
    allow_wide_open: z.boolean().default(false),
    require_approval_for_external_actions: z.boolean().default(true),
    require_receipts: z.boolean().default(true)
  }).default({
    allow_wide_open: false,
    require_approval_for_external_actions: true,
    require_receipts: true
  }),
  actions: z.object({
    allowed_commands: z.array(z.string()).default([
      "npm test",
      "npm run typecheck",
      "npm run lint"
    ]),
    blocked_commands: z.array(z.string()).default([
      "rm *",
      "git reset *",
      "git clean *",
      "sudo *"
    ]),
    command_timeout_ms: z.number().int().positive().default(120000),
    max_output_chars: z.number().int().positive().default(20000),
    allowed_write_paths: z.array(z.string()).default([
      ".agent-workflow/**",
      "docs/**"
    ]),
    blocked_write_paths: z.array(z.string()).default([
      ".git/**",
      "node_modules/**",
      ".env",
      ".env.*"
    ]),
    max_write_bytes: z.number().int().positive().default(200000)
  }).default({
    allowed_commands: ["npm test", "npm run typecheck", "npm run lint"],
    blocked_commands: ["rm *", "git reset *", "git clean *", "sudo *"],
    command_timeout_ms: 120000,
    max_output_chars: 20000,
    allowed_write_paths: [".agent-workflow/**", "docs/**"],
    blocked_write_paths: [".git/**", "node_modules/**", ".env", ".env.*"],
    max_write_bytes: 200000
  })
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
