import { createHash } from "node:crypto";
import { z } from "zod";

export const authorityLevels = ["observe", "propose", "simulate", "bounded_local", "approval_required", "approved_execute"] as const;
export const effectClasses = ["R0", "R1", "R2", "R3"] as const;
export const breakerScopes = ["global", "project", "workflow", "agent", "provider", "tool_class"] as const;
export const adversarialThreatClasses = ["prompt_injection", "malicious_repository_instruction", "poisoned_memory", "contradictory_approval", "secret_exposure", "cross_project_leakage", "misleading_evaluator", "hostile_tool_result"] as const;

export const adversarialCaseSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  threat_class: z.enum(adversarialThreatClasses),
  synthetic: z.literal(true),
  candidate_input: z.record(z.unknown()),
  network_allowed: z.literal(false),
  private_data_included: z.literal(false)
});

export const adversarialSuiteSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  local_only: z.literal(true),
  cases: z.array(adversarialCaseSchema).min(adversarialThreatClasses.length)
}).superRefine((suite, context) => {
  const ids = new Set<string>();
  const threats = new Set<string>();
  for (const item of suite.cases) {
    if (ids.has(item.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: `Duplicate adversarial case: ${item.id}` });
    ids.add(item.id);
    threats.add(item.threat_class);
  }
  for (const threat of adversarialThreatClasses) {
    if (!threats.has(threat)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: `Missing threat class: ${threat}` });
  }
});

export const stageAuthorityGrantSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  stage_id: z.string().min(1),
  requested_level: z.enum(authorityLevels),
  policy_ceiling: z.enum(authorityLevels),
  issued_level: z.enum(authorityLevels),
  effect_class: z.enum(effectClasses),
  evidence_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  breaker_generations: z.record(z.number().int().nonnegative()),
  issued_by: z.string().min(1),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  approval_id: z.string().min(1).optional(),
  preview_only: z.boolean().default(true)
}).superRefine((grant, context) => {
  const rank = (value: typeof authorityLevels[number]) => authorityLevels.indexOf(value);
  if (rank(grant.issued_level) > rank(grant.policy_ceiling) || rank(grant.issued_level) > rank(grant.requested_level)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["issued_level"], message: "Issued authority cannot exceed the request or policy ceiling." });
  }
  if ((grant.effect_class === "R2" || grant.effect_class === "R3") && !grant.approval_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approval_id"], message: `${grant.effect_class} effects require explicit approval.` });
  }
  if (grant.effect_class === "R3" && grant.issued_level === "approved_execute") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["issued_level"], message: "R3 effects are never autonomous in version 1." });
  }
});

export const breakerStateSchema = z.object({
  schema_version: z.literal(1),
  scope: z.enum(breakerScopes),
  scope_id: z.string().min(1),
  generation: z.number().int().nonnegative(),
  state: z.enum(["enabled", "tripped", "observe_only"]),
  reason: z.string().min(1),
  actor: z.string().min(1),
  created_at: z.string().datetime(),
  human_authored: z.boolean(),
  evidence_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).default([])
});

export type StageAuthorityGrant = z.infer<typeof stageAuthorityGrantSchema>;
export type BreakerState = z.infer<typeof breakerStateSchema>;

export function authorizeGuardedAction(input: {
  grant: StageAuthorityGrant;
  currentBreakers: BreakerState[] | null;
  now: string;
  mutation: boolean;
}): { allowed: boolean; level: typeof authorityLevels[number]; reasons: string[] } {
  const grant = stageAuthorityGrantSchema.parse(input.grant);
  const reasons: string[] = [];
  if (Date.parse(input.now) >= Date.parse(grant.expires_at)) reasons.push("authority grant expired");
  if (grant.preview_only && input.mutation) reasons.push("preview-only grant cannot authorize mutation");
  if (input.currentBreakers === null) {
    if (input.mutation) reasons.push("current breaker state is unreadable");
    return { allowed: !input.mutation && reasons.length === 0, level: "observe", reasons };
  }
  const breakers = input.currentBreakers.map((item) => breakerStateSchema.parse(item));
  for (const breaker of breakers) {
    const key = `${breaker.scope}:${breaker.scope_id}`;
    const expected = grant.breaker_generations[key];
    if (expected === undefined || expected !== breaker.generation) reasons.push(`stale breaker generation for ${key}`);
    if (breaker.state === "tripped") reasons.push(`breaker tripped for ${key}: ${breaker.reason}`);
    if (breaker.state === "observe_only" && input.mutation) reasons.push(`breaker restricts ${key} to observe-only`);
  }
  return { allowed: reasons.length === 0, level: reasons.length ? "observe" : grant.issued_level, reasons };
}

export const memoryClaimSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  project_id: z.string().min(1),
  tenant_id: z.string().min(1),
  source_kind: z.enum(["human_policy", "authoritative_source", "direct_observation", "derived_evidence", "summary", "model_inference"]),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().optional(),
  evidence_strength: z.number().min(0).max(1),
  dependency_ids: z.array(z.string().min(1)).default([]),
  conflict_ids: z.array(z.string().min(1)).default([]),
  permitted_use: z.enum(["planning", "action"]),
  state: z.enum(["current", "stale", "disputed", "revoked"])
});

export function authorizeMemoryUse(input: {
  claim: z.infer<typeof memoryClaimSchema>;
  projectId: string;
  tenantId: string;
  use: "planning" | "action";
  now: string;
  minimumActionStrength?: number;
}): { allowed: boolean; reasons: string[] } {
  const claim = memoryClaimSchema.parse(input.claim);
  const reasons: string[] = [];
  if (claim.project_id !== input.projectId || claim.tenant_id !== input.tenantId) reasons.push("memory scope mismatch");
  if (claim.expires_at && Date.parse(input.now) >= Date.parse(claim.expires_at)) reasons.push("memory expired");
  if (input.use === "action") {
    if (claim.permitted_use !== "action") reasons.push("memory is planning-only");
    if (claim.state !== "current") reasons.push(`memory is ${claim.state}`);
    if (claim.conflict_ids.length) reasons.push("memory has unresolved conflicts");
    if (claim.evidence_strength < (input.minimumActionStrength ?? 0.8)) reasons.push("memory evidence is too weak for action");
  } else if (claim.state === "revoked") reasons.push("revoked memory cannot be used");
  return { allowed: reasons.length === 0, reasons };
}

export const transactionReceiptSchema = z.object({
  schema_version: z.literal(1),
  transaction_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  lease_generation: z.number().int().nonnegative(),
  state: z.enum(["prepared", "simulated", "executing", "verifying", "completed", "compensating", "failed", "blocked"]),
  completed_checkpoints: z.array(z.string().min(1)),
  observed_effect_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
  verification: z.enum(["pending", "passed", "failed"]),
  unresolved_risks: z.array(z.string().min(1)),
  rollback_available: z.boolean()
});

export function advanceTransaction(input: {
  receipt: z.infer<typeof transactionReceiptSchema>;
  expectedLeaseGeneration: number;
  nextState: z.infer<typeof transactionReceiptSchema>["state"];
  verification?: "pending" | "passed" | "failed";
}): z.infer<typeof transactionReceiptSchema> {
  const receipt = transactionReceiptSchema.parse(input.receipt);
  if (receipt.lease_generation !== input.expectedLeaseGeneration) throw new Error("Stale lease generation cannot advance transaction.");
  const allowed: Record<typeof receipt.state, typeof receipt.state[]> = {
    prepared: ["simulated", "blocked", "failed"],
    simulated: ["executing", "blocked", "failed"],
    executing: ["verifying", "compensating", "failed"],
    verifying: ["completed", "compensating", "failed"],
    compensating: ["failed", "blocked"],
    completed: [], failed: [], blocked: []
  };
  if (!allowed[receipt.state].includes(input.nextState)) throw new Error(`Invalid transaction transition: ${receipt.state} -> ${input.nextState}`);
  const verification = input.verification ?? receipt.verification;
  if (input.nextState === "completed" && verification !== "passed") throw new Error("Completion requires fresh passing verification.");
  return transactionReceiptSchema.parse({ ...receipt, state: input.nextState, verification });
}

export const promotionEvidenceSchema = z.object({
  representative_cases: z.number().int().nonnegative(),
  cases_per_affected_workflow: z.record(z.number().int().nonnegative()),
  relative_quality_gain: z.number(),
  absolute_quality_gain_points: z.number(),
  confidence_excludes_meaningful_degradation: z.boolean(),
  new_severe_safety_violations: z.number().int().nonnegative(),
  verification_regression: z.number().nonnegative(),
  recovery_regression: z.number().nonnegative(),
  policy_regression: z.number().nonnegative(),
  cost_regression: z.number(),
  latency_regression: z.number(),
  cost_latency_exception_approved: z.boolean().default(false)
});

export function evaluatePromotionEvidence(input: unknown): {
  decision: "insufficient" | "recommendation_only" | "canary_eligible" | "blocked";
  reasons: string[];
} {
  const evidence = promotionEvidenceSchema.parse(input);
  const blockers: string[] = [];
  if (evidence.new_severe_safety_violations > 0) blockers.push("new severe safety violation");
  if (evidence.verification_regression > 0 || evidence.recovery_regression > 0 || evidence.policy_regression > 0) blockers.push("verification, recovery, or policy regression");
  if (!evidence.cost_latency_exception_approved && (evidence.cost_regression > 0.1 || evidence.latency_regression > 0.1)) blockers.push("cost or latency regression exceeds 10 percent");
  if (blockers.length) return { decision: "blocked", reasons: blockers };
  if (evidence.representative_cases < 10) return { decision: "insufficient", reasons: ["fewer than 10 representative cases"] };
  const qualityGain = evidence.relative_quality_gain >= 0.05 || evidence.absolute_quality_gain_points >= 3;
  const workflowCoverage = Object.values(evidence.cases_per_affected_workflow).every((count) => count >= 5);
  if (evidence.representative_cases < 30 || !workflowCoverage || !qualityGain || !evidence.confidence_excludes_meaningful_degradation) {
    return { decision: "recommendation_only", reasons: ["evidence does not satisfy the project-local canary gate"] };
  }
  return { decision: "canary_eligible", reasons: [] };
}

export function receiptHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
