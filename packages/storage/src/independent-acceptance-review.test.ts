import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { acceptanceDigest } from "./acceptance.js";
import { repairRevisionManifestHash, repairRevisionRequirementsDigest } from "./repaired-revision.js";
import { verifyIndependentAcceptanceReviewOnClient } from "./independent-acceptance-review.js";

function fixture(withCandidate = false, withReservation = false) {
  const manifest = [{ path: "source.ts", mode: 420, hash: "content" }], hash = repairRevisionManifestHash(manifest);
  const contract = { version: 1, contractId: "original-contract", projectId: "project", originRunId: "source", taskHash: acceptanceDigest("Original task"), subjectHash: hash,
    sourcePaths: ["source.ts"], deliverables: [{ id: "original", description: "All original requirements", requiredGates: ["implementation", "verification", "packaging", "supervision"], status: "pending", receipts: {}, gaps: [] }] };
  const auth = { version: 1, authority: "direct-human", approvalDecision: "approved", offlineOnly: true, authorizationId: "unique", sourceRunId: "source", reviewRunId: "review",
    claimId: "claim", claimFence: "1", projectId: "project", projectRootUri: "/synthetic/project", sourceHash: hash, sourcePaths: contract.sourcePaths,
    provider: "codex-cli", modelTier: "standard", originalContractDigest: acceptanceDigest(contract), requirementsDigest: repairRevisionRequirementsDigest(contract) };
  const source = { run_id: "source", project_key: "project", run_set_id: "family", canonical: true, root_uri: "/synthetic/project", task: "Original task", status: "failed",
    provider_override: "codex-cli", model_tier_override: "standard", evaluation_metadata: { acceptanceContract: contract } };
  const review = { ...source, run_id: "review", status: "completed", task: "Original task", policy_snapshot: { actions: { allowed_write_paths: [] as string[] } },
    evaluation_metadata: { kind: "explicit-independent-acceptance-review", sourceRunId: "source", independentReviewAuthorizationUri: "db://authorization",
      queueCoordinatorClaimId: "claim", queueCoordinatorFence: "1", originalAcceptanceDigest: acceptanceDigest(contract),
      acceptanceContract: { ...contract, contractId: "review-contract", originRunId: "review", taskHash: acceptanceDigest("Original task") } } };
  const state = { auth, source, review, receipt: true, duplicate: false, premature: false, pending: false, chain: true, accepted: true,
    bindings: ["review"], currentManifest: manifest, commands: ["python3 -m unittest discover -s tests"], live: true, canonical: true, receiptHash: "a".repeat(64),
    claim: { source_run_id: "source", project_id: "project", family_id: "project:family", child_id: "review", state: "running", owner: "owner", intent_fence: "1", file_scopes: ["source.ts"] } };
  const candidateState: { candidate?: any; baseline?: any; repair?: any; candidateDigest?: string; baselineDigest?: string; candidateAudit: number; repairChain: boolean; writes: any[]; candidateAt: string; baselineAt: string } = {
    candidateAudit: 2, repairChain: true, writes: [], candidateAt: "2026-01-01T00:00:02Z", baselineAt: "2026-01-01T00:00:00Z" };
  if (withCandidate) {
    const baselineManifest = [{ ...manifest[0], hash: "before-content" }], originalHash = repairRevisionManifestHash(baselineManifest);
    contract.subjectHash = originalHash;
    const originalDigest = acceptanceDigest(contract);
    auth.originalContractDigest = originalDigest;
    review.evaluation_metadata.originalAcceptanceDigest = originalDigest;
    Object.assign(auth, { repairedRevisionCandidateId: "candidate" });
    Object.assign(review.evaluation_metadata, { repairedRevisionCandidateId: "candidate" });
    candidateState.baseline = { id: "baseline", repairClaimId: "repair-claim", sourceRunId: "source", projectId: "project", repairOwner: "repair-owner",
      originalContractDigest: originalDigest, requirementsDigest: auth.requirementsDigest, sourceHash: originalHash, sourcePaths: auth.sourcePaths, manifest: baselineManifest };
    candidateState.baselineDigest = acceptanceDigest(candidateState.baseline);
    candidateState.candidate = { ...candidateState.baseline, id: "candidate", baselineId: "baseline", projectRootUri: auth.projectRootUri,
      repairRunId: "repair", repairedHash: hash, manifest };
    candidateState.candidateDigest = acceptanceDigest(candidateState.candidate);
    candidateState.repair = { status: "completed", child_id: "repair", owner: "repair-owner", fence: "1", provider_override: auth.provider, model_tier_override: auth.modelTier,
      evaluation_metadata: { sourceRunId: "source", queueCoordinatorClaimId: "repair-claim", queueCoordinatorFence: "1", originalAcceptanceDigest: originalDigest } };
    candidateState.writes = [{ content: { relativePath: "source.ts", previousHash: "before-content", nextHash: "content" }, receipted: true, created_at: "2026-01-01T00:00:01Z" }];
  }
  const reservationState: { authorization?: any; claim?: any; authority: boolean; duplicate: boolean; originalBound: boolean } = { authority: true, duplicate: false, originalBound: withReservation };
  if (withReservation) {
    const uri="db://one-review-reservation",key="one-human-grant",commands=[...state.commands];
    Object.assign(auth,{independentReviewReservationAuthorizationUri:uri,independentReviewApprovalId:key,authorizedCommands:commands});
    Object.assign(review.evaluation_metadata,{independentReviewReservationAuthorizationUri:uri,independentReviewApprovalId:key});
    reservationState.authorization={...auth,authorizationId:"reservation-id",approvalKey:key,reviewLimit:1,familyId:state.claim.family_id,taskHash:contract.taskHash,failureFingerprint:"original-failure"};
    const fingerprint=acceptanceDigest({failure:"original-failure",explicitIndependentReviewApprovalKey:key});
    Object.assign(state.claim,{fingerprint});
    reservationState.claim={id:"claim",fence:"1",sourceRunId:"source",projectId:"project",familyId:state.claim.family_id,role:"verifier",fingerprint,fileScopes:auth.sourcePaths,independentReviewReservationAuthorizationUri:uri};
  }
  const client = { query: async (sql: string) => {
    const rows = sql.includes("select content,created_at") ? [{ content: state.auth, created_at: "2026-01-01T00:00:03Z" }]
      : sql.includes("kind='candidate'") ? candidateState.candidate ? [{ payload: candidateState.candidate, digest: candidateState.candidateDigest, created_at: candidateState.candidateAt }] : []
      : sql.includes("kind='baseline'") ? [{ payload: candidateState.baseline, digest: candidateState.baselineDigest, created_at: candidateState.baselineAt }]
      : sql.includes("action_type='repaired_revision_candidate'") ? Array.from({ length: candidateState.candidateAudit }, () => ({}))
      : sql.includes("select r.*,q.owner") ? [candidateState.repair]
      : sql.includes("select a.content,a.created_at") ? candidateState.writes
      : sql.includes("content as reservation_authorization") ? reservationState.authorization ? [{reservation_authorization:reservationState.authorization,created_at:"2026-01-01T00:00:00Z"}] : []
      : sql.includes("kind='independent_review_reservation_authorization'") ? reservationState.duplicate ? [{}] : []
      : sql.includes("action_type='independent_review_reservation_authorized'") ? reservationState.authority ? [{receipt_hash:"a".repeat(64)}] : []
      : sql.includes("metadata ? 'independentReviewReservationAuthorizationUri'") ? reservationState.originalBound ? [{}] : []
      : sql.includes("action_type='queue_coordinator_reserved'") ? reservationState.claim ? [{metadata:reservationState.claim,receipt_hash:"a".repeat(64)}] : []
      : sql.includes("from action_receipts") ? state.receipt ? [{ receipt_hash: state.receiptHash }] : []
      : sql.includes("content->>'authorizationId'") ? state.duplicate ? [{}] : []
      : sql.includes("select id::text from workflow_runs") ? state.bindings.map(id => ({ id }))
      : sql.includes("select r.*,r.id::text") ? [state.source, state.review]
      : sql.includes("workflow_run_transitions") ? state.premature ? [{}] : []
      : sql.includes("from queue_coordinator_assignments") ? [state.claim]
      : sql.includes("from work_intents") ? (() => {
        assert.match(sql, /expires_at>clock_timestamp\(\)/u, "Live authority must use wall time, not a transaction's stale now()");
        return state.live ? [{}] : [];
      })()
      : sql.includes("with recursive family") ? state.pending ? [{}] : []
      : sql.includes("kind='command_output'") ? state.commands.map(commandLine => ({ content: { commandLine } }))
      : sql.includes("kind='stage_output'") ? [{ content: { artifact: { acceptanceContract: review.evaluation_metadata.acceptanceContract } } }]
      : (() => { throw new Error(`Unexpected query ${sql}`); })();
    return { rows, rowCount: rows.length };
  } } as unknown as Client;
  const run = () => verifyIndependentAcceptanceReviewOnClient(client, { sourceRunId: "source", reviewRunId: "review", authorizationArtifactUri: "db://authorization", requireLiveClaim: true }, {
    chain: async id => state.chain && (id !== "repair" || candidateState.repairChain), canonicalRoot: async () => state.canonical, manifest: async () => state.currentManifest,
    preflight: async () => ({ accepted: state.accepted, decisions: [] })
  });
  return { state, candidateState, reservationState, run };
}

test("validates a separately authorized completed review without changing failed source history", async () => {
  const { state, run } = fixture(), before = JSON.stringify(state);
  assert.equal(await run(), true); assert.equal(JSON.stringify(state), before); assert.equal(state.source.status, "failed");
});
test("final review validates its exact consumed one-use reservation authority", async()=>{
  const f=fixture(false,true);assert.equal(await f.run(),true);
});
for(const [name,change] of Object.entries({
  uri:(f:ReturnType<typeof fixture>)=>{(f.state.review.evaluation_metadata as any).independentReviewReservationAuthorizationUri="db://other";},
  key:(f:ReturnType<typeof fixture>)=>{f.reservationState.authorization.approvalKey="other";},
  source:(f:ReturnType<typeof fixture>)=>{f.reservationState.authorization.sourceRunId="other";},
  claim:(f:ReturnType<typeof fixture>)=>{f.reservationState.claim.id="other";},
  fence:(f:ReturnType<typeof fixture>)=>{f.reservationState.claim.fence="2";},
  scope:(f:ReturnType<typeof fixture>)=>{f.reservationState.claim.fileScopes=["other.ts"];},
  receipt:(f:ReturnType<typeof fixture>)=>{f.reservationState.authority=false;},
  duplicate:(f:ReturnType<typeof fixture>)=>{f.reservationState.duplicate=true;},
  downgrade:(f:ReturnType<typeof fixture>)=>{delete (f.state.auth as any).independentReviewReservationAuthorizationUri;delete (f.state.review.evaluation_metadata as any).independentReviewReservationAuthorizationUri;}
}))test(`final review rejects reservation ${name} mismatch`,async()=>{const f=fixture(false,true);change(f);assert.equal(await f.run(),false);});

test("explicit candidate authorization preserves original source contract while reviewing its authenticated repaired revision", async () => {
  const { state, run } = fixture(true), before = JSON.stringify(state);
  assert.notEqual(state.auth.sourceHash, state.source.evaluation_metadata.acceptanceContract.subjectHash);
  assert.equal(await run(), true); assert.equal(JSON.stringify(state), before);
});
for (const [name, mutate] of Object.entries({
  digest: (f: ReturnType<typeof fixture>) => { f.candidateState.candidateDigest = "forged"; },
  candidateBinding: (f: ReturnType<typeof fixture>) => { (f.state.review.evaluation_metadata as any).repairedRevisionCandidateId = "other"; },
  candidateHash: (f: ReturnType<typeof fixture>) => { f.candidateState.candidate.repairedHash = "other"; f.candidateState.candidateDigest = acceptanceDigest(f.candidateState.candidate); },
  originalDigest: (f: ReturnType<typeof fixture>) => { f.candidateState.candidate.originalContractDigest = "other"; f.candidateState.candidateDigest = acceptanceDigest(f.candidateState.candidate); },
  baseline: (f: ReturnType<typeof fixture>) => { f.candidateState.baselineDigest = "forged"; },
  audit: (f: ReturnType<typeof fixture>) => { f.candidateState.candidateAudit = 1; },
  incompleteRepair: (f: ReturnType<typeof fixture>) => { f.candidateState.repair.status = "failed"; },
  repairChain: (f: ReturnType<typeof fixture>) => { f.candidateState.repairChain = false; },
  writePreimage: (f: ReturnType<typeof fixture>) => { f.candidateState.writes[0].content.previousHash = "forged"; },
  writeReceipt: (f: ReturnType<typeof fixture>) => { f.candidateState.writes[0].receipted = false; },
  lateCandidate: (f: ReturnType<typeof fixture>) => { f.candidateState.candidateAt = "2026-01-01T00:00:03Z"; },
  lateBaseline: (f: ReturnType<typeof fixture>) => { f.candidateState.baselineAt = "2026-01-01T00:00:02Z"; },
  invalidCandidateTime: (f: ReturnType<typeof fixture>) => { f.candidateState.candidateAt = "invalid"; },
  invalidBaselineTime: (f: ReturnType<typeof fixture>) => { f.candidateState.baselineAt = "invalid"; },
  currentDrift: (f: ReturnType<typeof fixture>) => { f.state.currentManifest = [{ ...f.state.currentManifest[0], hash: "drift" }]; }
})) test(`candidate review fails closed on ${name}`, async () => {
  const f = fixture(true); mutate(f); assert.equal(await f.run(), false);
});

for (const [name, change] of Object.entries({
  approval: (s: ReturnType<typeof fixture>["state"]) => { s.auth.approvalDecision = "pending"; },
  offline: (s: ReturnType<typeof fixture>["state"]) => { s.auth.offlineOnly = false; },
  receipt: (s: ReturnType<typeof fixture>["state"]) => { s.receipt = false; },
  duplicate: (s: ReturnType<typeof fixture>["state"]) => { s.duplicate = true; },
  binding: (s: ReturnType<typeof fixture>["state"]) => { s.bindings.push("other"); },
  premature: (s: ReturnType<typeof fixture>["state"]) => { s.premature = true; },
  pending: (s: ReturnType<typeof fixture>["state"]) => { s.pending = true; },
  chain: (s: ReturnType<typeof fixture>["state"]) => { s.chain = false; },
  acceptance: (s: ReturnType<typeof fixture>["state"]) => { s.accepted = false; },
  drift: (s: ReturnType<typeof fixture>["state"]) => { s.currentManifest = [{ ...s.currentManifest[0], hash: "drift" }]; },
  live: (s: ReturnType<typeof fixture>["state"]) => { s.live = false; },
  external: (s: ReturnType<typeof fixture>["state"]) => { s.commands = ["curl https://example.invalid"]; },
  writable: (s: ReturnType<typeof fixture>["state"]) => { s.review.policy_snapshot.actions.allowed_write_paths = ["**"]; },
  route: (s: ReturnType<typeof fixture>["state"]) => { s.review.provider_override = "other"; },
  requirements: (s: ReturnType<typeof fixture>["state"]) => { s.review.evaluation_metadata.acceptanceContract.deliverables = []; },
  terminal: (s: ReturnType<typeof fixture>["state"]) => { s.review.status = "running"; },
  root: (s: ReturnType<typeof fixture>["state"]) => { s.review.root_uri = "/other"; },
  fence: (s: ReturnType<typeof fixture>["state"]) => { s.review.evaluation_metadata.queueCoordinatorFence = "2"; },
  task: (s: ReturnType<typeof fixture>["state"]) => { s.review.task = "Weakened task"; },
  family: (s: ReturnType<typeof fixture>["state"]) => { s.claim.family_id = "other-family"; },
  canonical: (s: ReturnType<typeof fixture>["state"]) => { s.source.canonical = false; },
  symlink: (s: ReturnType<typeof fixture>["state"]) => { s.canonical = false; },
  receiptHash: (s: ReturnType<typeof fixture>["state"]) => { s.receiptHash = ""; },
  vendor: (s: ReturnType<typeof fixture>["state"]) => { s.source.root_uri = s.review.root_uri = s.auth.projectRootUri = "/synthetic/vendor/project"; }
})) test(`fails closed on ${name} mismatch`, async () => {
  const { state, run } = fixture(); change(state);
  // Malformed requirements also remain fail-closed rather than becoming acceptance.
  let accepted = false; try { accepted = await run(); } catch { /* refusal */ }
  assert.equal(accepted, false);
});
