import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePeerAssessments, buildLearningProposal, createLearningQuestion, createPeerExchangeReceipt, learningResponseSchema, peerAssessmentSchema } from "./index.js";

const now = "2026-09-25T12:00:00.000Z";
const question = createLearningQuestion({ projectId: "project", taskClass: "security-review", requesterAgentId: "technical-architect", respondentAgentId: "security-reviewer", question: "Review the trust boundary.", rubricVersion: "1", allowedEvidenceHashes: ["source-1"], expiresAt: "2026-09-26T12:00:00.000Z", now: new Date(now) });
const response = learningResponseSchema.parse({ id: "response-1", questionId: question.id, respondentAgentId: "security-reviewer", answer: "The boundary needs a revocation check.", evidenceHashes: ["source-1"], confidence: 0.8, createdAt: now });

function assessment(reviewerAgentId: string, score = 4) {
  return peerAssessmentSchema.parse({ id: `assessment-${reviewerAgentId}`, questionId: question.id, responseId: response.id, reviewerAgentId, respondentAgentId: "security-reviewer", scores: { correctness: score, completeness: score, evidenceQuality: score, policyCompliance: score, usefulness: score, clarity: score, verificationStrength: score, uncertaintyHandling: score }, rationale: "The claim is supported by the cited check.", evidenceHashes: ["check-1"], confidence: 0.9, createdAt: now });
}

test("peer exchanges are immutable, evidence-bound receipts", () => {
  const receipt = createPeerExchangeReceipt({ question, response, assessments: [assessment("test-engineer")] });
  assert.equal(receipt.kind, "agentflow_peer_learning_exchange");
  assert.equal(receipt.bodyHash.length, 64);
  assert.deepEqual(receipt.participants, ["technical-architect", "security-reviewer", "test-engineer"]);
});

test("peer ratings remain advisory without independent verification and human confirmation", () => {
  const aggregate = aggregatePeerAssessments({ assessments: [assessment("test-engineer"), assessment("ux-reviewer")], calibrations: [], deterministicChecksPassed: true, humanFeedbackConfirmed: false });
  assert.equal(aggregate.status, "advisory");
  assert.equal(buildLearningProposal({ question, aggregate, target: "agent_prompt" }).status, "blocked");
});

test("calibrated independent agreement can only propose into the existing promotion pipeline", () => {
  const reviewers = [assessment("test-engineer"), assessment("ux-reviewer")];
  const aggregate = aggregatePeerAssessments({ assessments: reviewers, calibrations: reviewers.map((item) => ({ reviewerAgentId: item.reviewerAgentId, sampleCount: 10, verifiedAgreement: 0.9, humanAgreement: 0.9 })), deterministicChecksPassed: true, humanFeedbackConfirmed: true });
  assert.equal(aggregate.status, "promotion-eligible");
  assert.equal(buildLearningProposal({ question, aggregate, target: "agent_prompt" }).status, "proposed");
});

test("collusive-looking reciprocal or uniform ratings are not promotion eligible", () => {
  const aggregate = aggregatePeerAssessments({ assessments: [assessment("test-engineer", 5), assessment("ux-reviewer", 5)], calibrations: [], deterministicChecksPassed: true, humanFeedbackConfirmed: true, priorPairs: [
    { reviewerAgentId: "test-engineer", respondentAgentId: "security-reviewer" }, { reviewerAgentId: "test-engineer", respondentAgentId: "security-reviewer" }, { reviewerAgentId: "security-reviewer", respondentAgentId: "test-engineer" }, { reviewerAgentId: "security-reviewer", respondentAgentId: "test-engineer" }, { reviewerAgentId: "security-reviewer", respondentAgentId: "test-engineer" }
  ] });
  assert.equal(aggregate.status, "advisory");
  assert.ok(aggregate.risks.includes("reciprocal-rating-concentration"));
  assert.ok(aggregate.risks.includes("uniform-maximum-scores"));
});

test("self-rating is rejected by schema", () => {
  assert.throws(() => assessment("security-reviewer"), /Self-rating is forbidden/u);
});

test("circular grading and concentrated reviewers remain advisory", () => {
  const aggregate = aggregatePeerAssessments({ assessments: [assessment("test-engineer"), assessment("ux-reviewer")], calibrations: [], deterministicChecksPassed: true, humanFeedbackConfirmed: true, priorPairs: [
    { reviewerAgentId: "security-reviewer", respondentAgentId: "test-engineer" },
    { reviewerAgentId: "test-engineer", respondentAgentId: "security-reviewer" },
    { reviewerAgentId: "test-engineer", respondentAgentId: "ux-reviewer" },
    { reviewerAgentId: "test-engineer", respondentAgentId: "technical-architect" },
    { reviewerAgentId: "test-engineer", respondentAgentId: "implementation-agent" },
    { reviewerAgentId: "test-engineer", respondentAgentId: "docs-maintainer" },
    { reviewerAgentId: "test-engineer", respondentAgentId: "release-manager" }
  ] });
  assert.equal(aggregate.status, "advisory");
  assert.ok(aggregate.risks.includes("circular-grading"));
  assert.ok(aggregate.risks.includes("reviewer-concentration"));
});
