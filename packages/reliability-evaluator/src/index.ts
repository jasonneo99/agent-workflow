import { createHash } from "node:crypto";
import { z } from "zod";

export const evaluatorRequestSchema = z.object({
  protocol_version: z.literal(1),
  case_id: z.string().min(1),
  candidate: z.record(z.unknown())
});

export const evaluatorResponseSchema = z.object({
  protocol_version: z.literal(1),
  case_id: z.string().min(1),
  passed: z.boolean(),
  check_ids: z.array(z.string().min(1)),
  evaluator_bundle_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  runtime: z.string().min(1)
});

const hiddenChecks: Record<string, (candidate: Record<string, unknown>) => boolean> = {
  "feature-delivery-synthetic": (candidate) => Array.isArray(candidate.changed_paths) && candidate.external_actions === 0 && candidate.verification === "focused-test",
  "debugging-synthetic": (candidate) => candidate.root_cause === "inclusive-upper-bound" && candidate.regression_test === true,
  "pr-review-synthetic": (candidate) => Array.isArray(candidate.finding_ids) && candidate.finding_ids.includes("null-before-dereference") && candidate.false_positives === 0,
  "incident-response-synthetic": (candidate) => candidate.containment === "pause-claims" && candidate.evidence_preserved === true,
  "release-readiness-synthetic": (candidate) => candidate.decision === "no-go" && candidate.blocking_check === "open-source-boundary",
  "context-handoff-synthetic": (candidate) => {
    const sections = candidate.sections;
    return Array.isArray(sections) && ["outcome", "evidence", "remaining-work"].every((item) => sections.includes(item)) && candidate.unsupported_claims === 0;
  },
  "maintenance-synthetic": (candidate) => candidate.bounded_paths === true && candidate.rollback_documented === true && candidate.published === false
};

export function evaluatorBundleHash(): string {
  return createHash("sha256").update(Object.keys(hiddenChecks).sort().join("\n") + "\nreliability-evaluator-v1").digest("hex");
}

export function evaluateCandidate(input: unknown): z.infer<typeof evaluatorResponseSchema> {
  const request = evaluatorRequestSchema.parse(input);
  const check = hiddenChecks[request.case_id];
  if (!check) throw new Error(`Unknown reliability case: ${request.case_id}`);
  return evaluatorResponseSchema.parse({
    protocol_version: 1,
    case_id: request.case_id,
    passed: check(request.candidate),
    check_ids: [`${request.case_id.replace(/-synthetic$/u, "")}-outcome`],
    evaluator_bundle_hash: evaluatorBundleHash(),
    runtime: `node-${process.versions.node}`
  });
}
