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
  max_write_bytes: z.number().int().positive().optional(),
  approval_rules: z.array(z.object({
    id: z.string().min(1),
    description: z.string().default(""),
    action_type: z.enum(["local_command", "file_write"]),
    target: z.string().min(1),
    effect: z.enum(["auto_execute"]).default("auto_execute"),
    max_bytes: z.number().int().positive().optional()
  })).optional()
}).default({});

export const executionPolicyProfileSchema = z.object({
  autonomy: autonomyLevelSchema.optional(),
  policies: policyOverridesSchema,
  actions: actionOverridesSchema
});

export type ExecutionPolicyProfile = z.infer<typeof executionPolicyProfileSchema>;

const workerPoolLaneSchema = z.object({
  id: z.string().min(1),
  worker_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  concurrency: z.number().int().positive().max(16).optional(),
  lease_seconds: z.number().int().min(30).max(3600).optional(),
  interval_ms: z.number().int().min(250).optional(),
  project_scoped: z.boolean().optional()
});

const workerPoolProfileSchema = z.object({
  description: z.string().default(""),
  worker_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  concurrency: z.number().int().positive().max(16).optional(),
  lease_seconds: z.number().int().min(30).max(3600).optional(),
  interval_ms: z.number().int().min(250).optional(),
  project_scoped: z.boolean().optional(),
  lanes: z.array(workerPoolLaneSchema).min(1).default([{ id: "default" }])
});

const workerPoolSchema = z.object({
  worker_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(6),
  concurrency: z.number().int().positive().max(16).default(1),
  lease_seconds: z.number().int().min(30).max(3600).default(900),
  interval_ms: z.number().int().min(250).default(2000),
  project_scoped: z.boolean().default(true),
  default_profile: z.string().min(1).default("local"),
  profiles: z.record(z.string(), workerPoolProfileSchema).default({})
}).default({ limit: 6, concurrency: 1, lease_seconds: 900, interval_ms: 2000, project_scoped: true, default_profile: "local", profiles: {} });

const teamRoleSchema = z.object({
  description: z.string().default(""),
  can_request_approvals: z.boolean().default(false),
  can_approve_actions: z.boolean().default(false),
  can_reject_actions: z.boolean().default(false),
  can_execute_approved_actions: z.boolean().default(false),
  can_author_workflows: z.boolean().default(false),
  read_only: z.boolean().default(false)
});

const separationOfDutiesSchema = z.object({
  mode: z.enum(["off", "preview", "enforce"]).default("off"),
  prevent_same_actor_approval_execution: z.boolean().default(true)
}).default({
  mode: "off",
  prevent_same_actor_approval_execution: true
});

const artifactLifecycleSchema = z.object({
  retention_days: z.number().int().positive().default(30),
  min_prune_bytes: z.number().int().positive().default(20_000),
  retain_audit_artifacts: z.boolean().default(true),
  legal_hold: z.boolean().default(false),
  require_approval_for_prune: z.boolean().default(true),
  allow_archive_execution: z.boolean().default(false),
  allow_restore_execution: z.boolean().default(false),
  allow_prune_execution: z.boolean().default(false)
}).default({
  retention_days: 30,
  min_prune_bytes: 20_000,
  retain_audit_artifacts: true,
  legal_hold: false,
  require_approval_for_prune: true,
  allow_archive_execution: false,
  allow_restore_execution: false,
  allow_prune_execution: false
});

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
    semantic_index: z.boolean().default(true),
    artifact_lifecycle: artifactLifecycleSchema
  }).default({
    cache_summaries: true,
    semantic_index: true,
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
  }),
  execution: z.object({
    policy_profile: z.string().min(1).default("local"),
    policy_profiles: z.record(z.string(), executionPolicyProfileSchema).default({}),
    worker_pool: workerPoolSchema.optional()
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
  team: z.object({
    enforcement: z.enum(["preview", "enforce"]).default("preview"),
    default_actor_role: z.string().min(1).default("operator"),
    roles: z.record(z.string(), teamRoleSchema).default({}),
    separation_of_duties: separationOfDutiesSchema
  }).default({
    enforcement: "preview",
    default_actor_role: "operator",
    roles: {},
    separation_of_duties: {
      mode: "off",
      prevent_same_actor_approval_execution: true
    }
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
    max_write_bytes: z.number().int().positive().default(200000),
    approval_rules: z.array(z.object({
      id: z.string().min(1),
      description: z.string().default(""),
      action_type: z.enum(["local_command", "file_write"]),
      target: z.string().min(1),
      effect: z.enum(["auto_execute"]).default("auto_execute"),
      max_bytes: z.number().int().positive().optional()
    })).default([])
  }).default({
    allowed_commands: ["npm test", "npm run typecheck", "npm run lint"],
    blocked_commands: ["rm *", "git reset *", "git clean *", "sudo *"],
    command_timeout_ms: 120000,
    max_output_chars: 20000,
    allowed_write_paths: [".agent-workflow/**", "docs/**"],
    blocked_write_paths: [".git/**", "node_modules/**", ".env", ".env.*"],
    max_write_bytes: 200000,
    approval_rules: []
  })
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
