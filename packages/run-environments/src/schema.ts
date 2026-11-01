import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u).refine(value => !value.includes(".."));
const relativePath = z.string().min(1).max(512).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
  value.split("/").every(part => part !== ".." && part !== "." && part !== "") && !value.includes("*"),
"Use an exact project-relative file or directory.");
const argv = z.array(z.string().max(16_384).refine(value => !value.includes("\0"))).min(1).max(128)
  .refine(value => Boolean(value[0]?.trim()), "An executable is required.");
const image = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/u);
const probe = z.object({ argv, expect_output: z.string().min(1).max(500).optional(),
  attempts: z.number().int().min(1).max(30).default(1),
  interval_ms: z.number().int().min(50).max(5000).default(250) }).strict();

export const environmentProfileSchema = z.object({
  kind: z.enum(["container", "native"]).default("container"),
  platform: z.enum(["linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64", "win32/amd64", "win32/arm64"]),
  image: image.optional(),
  source_paths: z.array(relativePath).min(1).max(128),
  source_extensions: z.array(z.string().regex(/^\.[a-zA-Z0-9]+$/u)).max(40).optional(),
  source_exclude_paths: z.array(relativePath).max(128).optional(),
  fixture_paths: z.array(relativePath).max(128).optional(),
  dependency_paths: z.array(relativePath).max(128).default([]),
  setup: z.array(argv).max(32).default([]),
  build_network: z.enum(["none", "default"]).default("none"),
  readiness: z.array(probe).min(1).max(32),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), z.string().max(2048).refine(value => !value.includes("\0"))).default({}),
  services: z.record(name, z.object({
    image,
    user: z.string().regex(/^[1-9][0-9]{0,5}(?::[1-9][0-9]{0,5})?$/u).default("10001:10001"),
    argv: argv.optional(),
    // Explicit test configuration only; host variables are never inherited.
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), z.string().max(2048).refine(value => !value.includes("\0"))).default({}),
    readiness: probe
  }).strict()).default({}),
  verification: z.array(z.object({
    commands: z.array(z.string().min(1).max(4096)).min(1).max(32),
    format: z.enum(["node-test", "unittest", "pytest"]),
    minimum_tests: z.number().int().positive().max(1_000_000).default(1),
    expected_tests: z.number().int().positive().max(1_000_000).optional()
  }).strict()).max(32).default([]),
  limits: z.object({
    cpus: z.number().positive().max(16).default(2),
    memory_mb: z.number().int().min(128).max(32_768).default(2048),
    pids: z.number().int().min(16).max(4096).default(256),
    timeout_ms: z.number().int().min(100).max(3_600_000).default(120_000),
    preparation_timeout_ms: z.number().int().min(100).max(3_600_000).default(600_000),
    max_output_chars: z.number().int().min(256).max(1_000_000).default(20_000),
    max_source_bytes: z.number().int().min(1).max(536_870_912).default(67_108_864),
    max_files: z.number().int().min(1).max(20_000).default(4096)
  }).strict().default({})
}).strict().superRefine((profile, context) => {
  if (profile.kind === "container" && (!profile.image || !profile.platform.startsWith("linux/"))) {
    context.addIssue({ code: "custom", message: "Container profiles need a digest-pinned image and a Linux target platform." });
  }
  if (profile.kind === "native" && (profile.image || profile.setup.length || Object.keys(profile.services).length || Object.keys(profile.env).length || profile.build_network !== "none")) {
    context.addIssue({ code: "custom", message: "Native profiles use an existing matching host; automatic installation and container services are unavailable." });
  }
  if (Object.keys(profile.services).length > 8) context.addIssue({ code: "custom", message: "At most eight isolated services are supported." });
});

export const runEnvironmentsSchema = z.object({
  docker_context: name.default("default"),
  default_profile: name.optional(),
  profiles: z.record(name, environmentProfileSchema),
  selectors: z.array(z.object({
    profile: name,
    run: name.optional(),
    workflow: name.optional(),
    stage: name.optional(),
    command: z.string().min(1).max(4096).optional()
  }).strict()).max(128).default([])
}).strict().superRefine((config, context) => {
  for (const selected of [config.default_profile, ...config.selectors.map(selector => selector.profile)]) {
    if (selected && !config.profiles[selected]) context.addIssue({ code: "custom", message: `Unknown environment profile: ${selected}` });
  }
});

export type EnvironmentProfile = z.infer<typeof environmentProfileSchema>;
export type RunEnvironments = z.infer<typeof runEnvironmentsSchema>;
export const repairCommitPolicySchema = z.object({
  enabled: z.boolean().default(false),
  stages: z.array(z.string().min(1)).default(["implement", "repair"])
}).strict();
export const runPipelinePolicySchema = z.object({
  required: z.boolean().default(false),
  isolation: z.literal("worktree").default("worktree")
}).strict();
export interface EnvironmentContext {
  runId: string;
  taskId?: string;
  workflowId?: string;
  stageId?: string;
  profile?: string;
  requireVerification?: boolean;
  requireEnvironment?: boolean;
  managedSource?: boolean;
  /** Independent runs may reuse a frozen recipe, never another run's authority. */
  reuseRunId?: string;
}

export const ENVIRONMENT_COMMAND = "npm run agentflow -- environments *";
