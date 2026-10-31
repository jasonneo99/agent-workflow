import type { Client } from "pg";
import fs from "node:fs/promises";
import { acceptanceDigest, acceptancePreflight } from "./acceptance.js";
import { captureRepairRevisionManifest, effectiveRepairContractOnClient, repairRevisionManifestHash, repairRevisionRequirementsDigest } from "./repaired-revision.js";
import { isVerificationCommand } from "../../workflow-engine/src/action-result-continuation.js";

/** No new repair or candidate is made here; revalidate an existing immutable, audited candidate. */
export async function verifyIndependentReviewCandidateOnClient(c: Client, auth: any, metadata: any, original: any,
  chain: (id: string) => Promise<boolean>, authorizationCreatedAt?: string | Date): Promise<boolean> {
  const id = auth.repairedRevisionCandidateId;
  if (typeof id !== "string" || !id || metadata.repairedRevisionCandidateId !== id) return false;
  const rows = await c.query(`select payload,digest,created_at from repaired_revision_records
    where id=$1 and kind='candidate' and source_run_id=$2`, [id, auth.sourceRunId]);
  if (rows.rows.length !== 1) return false;
  const row = rows.rows[0], candidate = row.payload;
  const candidateAt = new Date(row.created_at).getTime();
  if (!Number.isFinite(candidateAt) || (authorizationCreatedAt !== undefined
    && (!Number.isFinite(new Date(authorizationCreatedAt).getTime()) || candidateAt >= new Date(authorizationCreatedAt).getTime()))) return false;
  if (acceptanceDigest(candidate) !== row.digest || candidate.id !== id || candidate.sourceRunId !== auth.sourceRunId
    || candidate.projectId !== auth.projectId || candidate.projectRootUri !== auth.projectRootUri
    || candidate.originalContractDigest !== auth.originalContractDigest || candidate.requirementsDigest !== auth.requirementsDigest
    || candidate.sourceHash !== original.subjectHash || candidate.repairedHash !== auth.sourceHash
    || candidate.legacyEnrollmentId !== metadata.legacyEnrollmentId
    || acceptanceDigest(candidate.sourcePaths) !== acceptanceDigest(auth.sourcePaths)
    || repairRevisionManifestHash(candidate.manifest) !== auth.sourceHash) return false;
  const audit = await c.query(`select 1 from action_receipts where run_id=$1 and action_type='repaired_revision_candidate'
    and metadata=$2::jsonb union all select 1 from artifacts where run_id=$1 and kind='repaired_revision_candidate'
    and content=$2::jsonb`, [auth.sourceRunId, JSON.stringify(candidate)]);
  if (audit.rows.length !== 2) return false;
  const baselines = await c.query(`select payload,digest,created_at from repaired_revision_records
    where id=$1 and kind='baseline' and claim_id=$2 and source_run_id=$3`, [candidate.baselineId, candidate.repairClaimId, auth.sourceRunId]);
  if (baselines.rows.length !== 1 || acceptanceDigest(baselines.rows[0].payload) !== baselines.rows[0].digest) return false;
  const baseline = baselines.rows[0].payload;
  const baselineAt = new Date(baselines.rows[0].created_at).getTime();
  if (!Number.isFinite(baselineAt) || baselineAt >= candidateAt) return false;
  if (baseline.id !== candidate.baselineId || baseline.repairClaimId !== candidate.repairClaimId
    || baseline.sourceRunId !== auth.sourceRunId || baseline.projectId !== auth.projectId
    || baseline.repairOwner !== candidate.repairOwner || baseline.originalContractDigest !== auth.originalContractDigest
    || baseline.requirementsDigest !== auth.requirementsDigest || baseline.sourceHash !== original.subjectHash
    || baseline.legacyEnrollmentId !== metadata.legacyEnrollmentId
    || acceptanceDigest(baseline.sourcePaths) !== acceptanceDigest(auth.sourcePaths)
    || repairRevisionManifestHash(baseline.manifest) !== original.subjectHash) return false;
  const repairs = await c.query(`select r.*,q.owner,q.fence,q.child_run_id::text child_id from workflow_runs r
    join queue_coordinator_assignments q on q.id=$2 where r.id=$1 and q.role='repair'
    and q.source_run_id=$3 and q.project_id=$4 and r.project_id=$4`, [candidate.repairRunId, candidate.repairClaimId, auth.sourceRunId, auth.projectId]);
  const repair = repairs.rows[0], rm = repair?.evaluation_metadata;
  if (!repair || repair.status !== "completed" || repair.child_id !== candidate.repairRunId
    || repair.owner !== candidate.repairOwner || rm?.queueCoordinatorClaimId !== candidate.repairClaimId
    || rm.queueCoordinatorFence !== String(repair.fence) || rm.sourceRunId !== auth.sourceRunId
    || repair.provider_override !== auth.provider || repair.model_tier_override !== auth.modelTier
    || rm.originalAcceptanceDigest !== auth.originalContractDigest || rm.legacyEnrollmentId !== metadata.legacyEnrollmentId
    || !await chain(candidate.repairRunId)) return false;
  const writes = await c.query(`select a.content,a.created_at,exists(select 1 from action_receipts r
    where r.run_id=a.run_id and r.action_type='file_write' and r.target=a.content->>'relativePath' and r.metadata=a.content) receipted
    from artifacts a where a.run_id=$1 and a.kind='file_write' order by a.created_at,a.id`, [candidate.repairRunId]);
  const before = new Map<string, { path: string; mode: number; hash: string }>(baseline.manifest.map((e: any) => [e.path, e]));
  for (const write of writes.rows) {
    const w = write.content, previous = before.get(w.relativePath);
    if (!previous || !write.receipted || w.previousHash !== previous.hash || typeof w.nextHash !== "string"
      || !Number.isFinite(Date.parse(write.created_at)) || !Number.isFinite(Date.parse(baselines.rows[0].created_at))
      || Date.parse(write.created_at) <= Date.parse(baselines.rows[0].created_at)) return false;
    before.set(w.relativePath, { ...previous, hash: w.nextHash });
  }
  return candidate.manifest.length === before.size && candidate.manifest.every((e: any) => acceptanceDigest(e) === acceptanceDigest(before.get(e.path)));
}

export interface IndependentAcceptanceReviewInput {
  sourceRunId: string;
  reviewRunId: string;
  authorizationArtifactUri: string;
  claimId?: string;
  claimFence?: string;
  requireLiveClaim?: boolean;
}
export interface IndependentAcceptanceReviewHooks {
  chain(runId: string): Promise<boolean>;
  manifest: typeof captureRepairRevisionManifest;
  preflight: typeof acceptancePreflight;
  canonicalRoot(root: string): Promise<boolean>;
}

export async function verifySealedIndependentReviewReservationOnClient(c: Client, auth: any, metadata: any, q: any, taskHash: string): Promise<boolean> {
  const uri = auth.independentReviewReservationAuthorizationUri, key = auth.independentReviewApprovalId;
  if (uri === undefined && metadata.independentReviewReservationAuthorizationUri === undefined) {
    const bound = await c.query(`select 1 from action_receipts where run_id=$1 and action_type='queue_coordinator_reserved'
      and metadata->>'id'=$2 and metadata ? 'independentReviewReservationAuthorizationUri' limit 1`, [auth.sourceRunId, auth.claimId]);
    return !bound.rowCount;
  }
  if (typeof uri !== "string" || !uri.startsWith("db://") || typeof key !== "string" || !key
    || metadata.independentReviewReservationAuthorizationUri !== uri || metadata.independentReviewApprovalId !== key) return false;
  const rows = await c.query(`select content as reservation_authorization,created_at from artifacts
    where run_id=$1 and uri=$2 and kind='independent_review_reservation_authorization'`, [auth.sourceRunId, uri]);
  if (rows.rows.length !== 1) return false;
  const a = rows.rows[0].reservation_authorization;
  if (a?.version !== 1 || a.authority !== "direct-human" || a.approvalDecision !== "approved" || a.offlineOnly !== true || a.reviewLimit !== 1
    || !a.authorizationId || a.approvalKey !== key || a.sourceRunId !== auth.sourceRunId || a.projectId !== auth.projectId
    || a.projectRootUri !== auth.projectRootUri || a.familyId !== q.family_id
    || a.taskHash !== taskHash
    || a.originalContractDigest !== auth.originalContractDigest || a.requirementsDigest !== auth.requirementsDigest
    || a.sourceHash !== auth.sourceHash || a.provider !== auth.provider || a.modelTier !== auth.modelTier
    || acceptanceDigest(a.sourcePaths) !== acceptanceDigest(auth.sourcePaths)
    || !Array.isArray(a.authorizedCommands) || !a.authorizedCommands.length || a.authorizedCommands.some((x: unknown) => typeof x !== "string" || !isVerificationCommand(x))
    || acceptanceDigest(a.authorizedCommands) !== acceptanceDigest(auth.authorizedCommands)
    || q.fingerprint !== acceptanceDigest({ failure: a.failureFingerprint, explicitIndependentReviewApprovalKey: key })) return false;
  const duplicates = await c.query(`select 1 from artifacts where kind='independent_review_reservation_authorization'
    and (content->>'approvalKey'=$1 or content->>'authorizationId'=$2) and uri<>$3 limit 1`, [key, a.authorizationId, uri]);
  if (duplicates.rowCount) return false;
  const authority = await c.query(`select receipt_hash from action_receipts where run_id=$1 and action_type='independent_review_reservation_authorized'
    and target=$2 and metadata=$3::jsonb and agent_id in ('operator','workflow-orchestrator') limit 2`, [auth.sourceRunId, uri, JSON.stringify(a)]);
  if (authority.rows.length !== 1 || !/^[a-f0-9]{64}$/u.test(authority.rows[0].receipt_hash ?? "")) return false;
  const claims = await c.query(`select metadata,receipt_hash from action_receipts where run_id=$1 and action_type='queue_coordinator_reserved'
    and metadata->>'id'=$2 limit 2`, [auth.sourceRunId, auth.claimId]);
  const claim = claims.rows[0]?.metadata;
  return claims.rows.length === 1 && /^[a-f0-9]{64}$/u.test(claims.rows[0].receipt_hash ?? "")
    && claim.id === auth.claimId && claim.fence === auth.claimFence && claim.sourceRunId === auth.sourceRunId
    && claim.projectId === auth.projectId && claim.familyId === q.family_id && claim.role === "verifier"
    && claim.fingerprint === q.fingerprint && claim.independentReviewReservationAuthorizationUri === uri
    && acceptanceDigest(claim.fileScopes) === acceptanceDigest(auth.sourcePaths);
}

/** Read-only validation of a separately human-authorized review, never a retry or historical acceptance rewrite. */
export async function verifyIndependentAcceptanceReviewOnClient(
  c: Client, input: IndependentAcceptanceReviewInput, hooks: Partial<IndependentAcceptanceReviewHooks> = {}
): Promise<boolean> {
  const h = { manifest: captureRepairRevisionManifest, preflight: acceptancePreflight,
    canonicalRoot: async (root: string) => await fs.realpath(root) === root,
    chain: async (id: string) => { const { verifyRunReceiptChainOnClient } = await import("./postgres.js"); return (await verifyRunReceiptChainOnClient(c, id)).valid; }, ...hooks };
  if (!input.authorizationArtifactUri.startsWith("db://") || input.sourceRunId === input.reviewRunId) return false;
  const authRows = await c.query(`select content,created_at from artifacts where run_id=$1 and uri=$2
    and kind='independent_acceptance_review_authorization'`, [input.sourceRunId, input.authorizationArtifactUri]);
  if (authRows.rows.length !== 1) return false;
  const auth = authRows.rows[0].content;
  if (auth?.version !== 1 || auth.authority !== "direct-human" || auth.approvalDecision !== "approved"
    || auth.offlineOnly !== true || !auth.authorizationId
    || auth.sourceRunId !== input.sourceRunId || auth.reviewRunId !== input.reviewRunId
    || !auth.claimId || typeof auth.claimFence !== "string"
    || (input.claimId !== undefined && input.claimId !== auth.claimId)
    || (input.claimFence !== undefined && input.claimFence !== auth.claimFence)) return false;
  const receipt = await c.query(`select receipt_hash from action_receipts where run_id=$1
    and action_type='independent_acceptance_review_authorization' and metadata=$2::jsonb
    and target=$3 and agent_id in ('operator','workflow-orchestrator') limit 2`, [input.sourceRunId, JSON.stringify(auth), input.authorizationArtifactUri]);
  if (receipt.rows.length !== 1 || !/^[a-f0-9]{64}$/u.test(receipt.rows[0].receipt_hash ?? "")) return false;
  const duplicate = await c.query(`select 1 from artifacts where kind='independent_acceptance_review_authorization'
    and content->>'authorizationId'=$1 and uri<>$2 limit 1`, [auth.authorizationId, input.authorizationArtifactUri]);
  if (duplicate.rowCount) return false;
  const reviewBindings = await c.query(`select id::text from workflow_runs
    where evaluation_metadata->>'independentReviewAuthorizationUri'=$1`, [input.authorizationArtifactUri]);
  if (reviewBindings.rows.length !== 1 || reviewBindings.rows[0].id !== input.reviewRunId) return false;
  const runs = await c.query(`select r.*,r.id::text run_id,r.project_id::text project_key,p.root_uri,
    exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
    from workflow_runs r join projects p on p.id=r.project_id where r.id=any($1::uuid[]) for share of r,p`, [[input.sourceRunId, input.reviewRunId]]);
  const source = runs.rows.find(r => r.run_id === input.sourceRunId), review = runs.rows.find(r => r.run_id === input.reviewRunId);
  if (!source || !review || source.project_key !== auth.projectId || review.project_key !== auth.projectId
    || source.root_uri !== auth.projectRootUri || review.root_uri !== auth.projectRootUri || review.status !== "completed"
    || !source.canonical || !review.canonical || /(^|\/)(vendor|node_modules)(\/|$)/iu.test(source.root_uri)
    || review.task !== source.task || !await h.canonicalRoot(source.root_uri)
    || !Number.isFinite(Date.parse(authRows.rows[0].created_at))) return false;
  const premature = await c.query(`select 1 from workflow_run_transitions where run_id=$1 and to_status in ('leased','running') and created_at<=$2
    union all select 1 from workflow_tasks where run_id=$1 and started_at<=$2
    union all select 1 from artifacts where run_id=$1 and kind='command_output' and created_at<=$2 limit 1`, [input.reviewRunId, authRows.rows[0].created_at]);
  if (premature.rowCount) return false;
  const m = review.evaluation_metadata;
  if (m?.kind !== "explicit-independent-acceptance-review" || m.sourceRunId !== input.sourceRunId
    || m.independentReviewAuthorizationUri !== input.authorizationArtifactUri
    || m.queueCoordinatorClaimId !== auth.claimId || m.queueCoordinatorFence !== auth.claimFence) return false;
  const assignment = await c.query(`select q.*,q.child_run_id::text child_id from queue_coordinator_assignments q
    where q.id=$1 and q.fence=$2::bigint and q.role='verifier' for share`, [auth.claimId, auth.claimFence]);
  const q = assignment.rows[0];
  if (!q || q.source_run_id !== input.sourceRunId || q.project_id !== auth.projectId || q.child_id !== input.reviewRunId
    || q.family_id !== `${auth.projectId}:${source.run_set_id}`
    || !["running", "verified"].includes(q.state) || acceptanceDigest(q.file_scopes) !== acceptanceDigest(auth.sourcePaths)) return false;
  if (!await verifySealedIndependentReviewReservationOnClient(c, auth, m, q, acceptanceDigest(source.task))) return false;
  if (input.requireLiveClaim) {
    const intent = await c.query(`select 1 from work_intents where project_id=$1 and owner=$2
      and fencing_token::text=$3 and file_scopes=$4::jsonb and expires_at>clock_timestamp()`, [auth.projectId, q.owner, q.intent_fence, JSON.stringify(q.file_scopes)]);
    if (q.state !== "running" || !intent.rowCount) return false;
  }
  let effective;
  try { effective = await effectiveRepairContractOnClient(c, source, { sourceRunId: input.sourceRunId, projectId: auth.projectId,
    fileScopes: auth.sourcePaths, legacyEnrollmentId: m.legacyEnrollmentId }); } catch { return false; }
  const original = effective.contract, contract = m.acceptanceContract;
  let requirementsDigest: string;
  try { requirementsDigest = repairRevisionRequirementsDigest(contract); } catch { return false; }
  if (auth.originalContractDigest !== acceptanceDigest(original) || m.originalAcceptanceDigest !== acceptanceDigest(original)
    || auth.requirementsDigest !== repairRevisionRequirementsDigest(original)
    || !contract || contract.version !== 1
    || contract.contractId === original.contractId || !contract.contractId || contract.projectId !== auth.projectId
    || contract.originRunId !== input.reviewRunId || contract.taskHash !== acceptanceDigest(review.task)
    || contract.subjectHash !== auth.sourceHash || acceptanceDigest(contract.sourcePaths) !== acceptanceDigest(auth.sourcePaths)
    || requirementsDigest !== auth.requirementsDigest) return false;
  if (auth.repairedRevisionCandidateId === undefined) {
    if (m.repairedRevisionCandidateId !== undefined || auth.sourceHash !== original.subjectHash) return false;
  } else if (!await verifyIndependentReviewCandidateOnClient(c, auth, m, original, h.chain, authRows.rows[0].created_at)) return false;
  const provider = effective.legacy?.provider ?? source.provider_override, tier = effective.legacy?.modelTier ?? source.model_tier_override;
  if (!provider || !tier || auth.provider !== provider || auth.modelTier !== tier
    || review.provider_override !== provider || review.model_tier_override !== tier
    || !Array.isArray(review.policy_snapshot?.actions?.allowed_write_paths) || review.policy_snapshot.actions.allowed_write_paths.length) return false;
  const commands = await c.query(`select content from artifacts where run_id=$1 and kind='command_output' order by created_at,id limit 1001`, [input.reviewRunId]);
  if (commands.rows.length > 1000 || commands.rows.some(row => typeof row.content?.commandLine !== "string" || !isVerificationCommand(row.content.commandLine))) return false;
  if (auth.independentReviewReservationAuthorizationUri !== undefined
    && commands.rows.some(row => !auth.authorizedCommands.includes(row.content.commandLine))) return false;
  const pending = await c.query(`with recursive family(id) as (
    select r.id from workflow_runs r join workflow_runs original on original.id=$1
      where r.id=original.id or (r.project_id=original.project_id and r.run_set_id=original.run_set_id)
    union select child.id from workflow_runs child join family parent on parent.id::text in
      (child.evaluation_metadata->>'sourceRunId',child.evaluation_metadata->>'replayOfRunId',child.evaluation_metadata->>'parentRunId',child.evaluation_metadata->>'repairOriginRunId')
  ) select 1 from action_approvals where run_id in (select id from family) and status in ('pending','executing')
    union all select 1 from workflow_runs where id in (select id from family) and id<>$2 and status in ('queued','leased','running')
    union all select 1 from workflow_tasks where run_id in (select id from family) and status in ('queued','leased','running')
    union all select 1 from artifacts where run_id=$2 and kind='file_write' limit 1`, [input.sourceRunId, input.reviewRunId]);
  if (pending.rowCount || !await h.chain(input.sourceRunId) || !await h.chain(input.reviewRunId)) return false;
  const outputs = await c.query(`select content from artifacts where run_id=$1 and kind='stage_output'
    order by created_at desc,id desc limit 100`, [input.reviewRunId]);
  let accepted = false;
  for (const row of outputs.rows) if ((await h.preflight(c, input.reviewRunId, row.content?.artifact ?? row.content)).accepted) { accepted = true; break; }
  if (!accepted) return false;
  return repairRevisionManifestHash(await h.manifest(auth.projectRootUri, auth.sourcePaths)) === auth.sourceHash;
}
