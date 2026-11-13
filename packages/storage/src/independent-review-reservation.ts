import fs from "node:fs/promises";
import type { Client } from "pg";
import type { CoordinatorReservation } from "./queue-coordinator.js";
import { acceptanceDigest } from "./acceptance.js";
import { effectiveRepairContractOnClient, repairRevisionRequirementsDigest } from "./repaired-revision.js";
import { sourceSubjectHash } from "../../workflow-engine/src/source-subject.js";

export interface IndependentReviewReservationHooks {
  chain(c: Client, runId: string): Promise<boolean>;
  canonicalRoot(root: string): Promise<boolean>;
  hash(root: string, paths: string[]): Promise<string>;
}

/** Called only under the coordinator transaction lock. Does not grant repairs or consume approval by itself. */
export async function authorizedIndependentReviewFingerprintOnClient(c: Client, input: CoordinatorReservation,
  hooks: Partial<IndependentReviewReservationHooks> = {}): Promise<string | null> {
  const uri = input.independentReviewReservationAuthorizationUri;
  if (input.role !== "verifier" || !uri?.startsWith("db://") || input.revisionCandidateId) return null;
  const h = { canonicalRoot: async (root: string) => await fs.realpath(root) === root, hash: sourceSubjectHash,
    chain: async (client: Client, runId: string) => { const { verifyRunReceiptChainOnClient } = await import("./postgres.js"); return (await verifyRunReceiptChainOnClient(client, runId)).valid; }, ...hooks };
  const rows = await c.query(`select content from artifacts where run_id=$1 and uri=$2
    and kind='independent_review_reservation_authorization'`, [input.sourceRunId, uri]);
  if (rows.rows.length !== 1) return null;
  const a = rows.rows[0].content;
  if (a?.version !== 1 || a.authority !== "direct-human" || a.approvalDecision !== "approved" || a.offlineOnly !== true
    || a.reviewLimit !== 1 || typeof a.authorizationId !== "string" || !a.authorizationId || typeof a.approvalKey !== "string" || !a.approvalKey
    || a.sourceRunId !== input.sourceRunId || a.projectId !== input.projectId || a.projectRootUri !== input.projectRootUri
    || a.familyId !== input.familyId || a.failureFingerprint !== input.fingerprint
    || acceptanceDigest(a.sourcePaths) !== acceptanceDigest(input.fileScopes)) return null;
  const duplicates = await c.query(`select 1 from artifacts where kind='independent_review_reservation_authorization'
    and (content->>'approvalKey'=$1 or content->>'authorizationId'=$2) and uri<>$3 limit 1`, [a.approvalKey, a.authorizationId, uri]);
  if (duplicates.rowCount) return null;
  const receipts = await c.query(`select receipt_hash from action_receipts where run_id=$1
    and action_type='independent_review_reservation_authorized' and target=$2 and metadata=$3::jsonb
    and agent_id in ('operator','workflow-orchestrator') limit 2`, [input.sourceRunId, uri, JSON.stringify(a)]);
  if (receipts.rows.length !== 1 || !/^[a-f0-9]{64}$/u.test(receipts.rows[0].receipt_hash ?? "")) return null;
  const sources = await c.query(`select r.*,r.project_id::text project_key,p.root_uri,
    exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
    from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for share of r,p`, [input.sourceRunId]);
  const source = sources.rows[0];
  if (!source?.canonical || source.root_uri !== input.projectRootUri || source.project_key !== input.projectId
    || `${source.project_key}:${source.run_set_id}` !== input.familyId
    || /(^|\/)(vendor|node_modules)(\/|$)/iu.test(source.root_uri) || !await h.canonicalRoot(source.root_uri)) return null;
  let effective;
  try { effective = await effectiveRepairContractOnClient(c, source, input); } catch { return null; }
  const contract = effective.contract;
  const provider = effective.legacy?.provider ?? source.provider_override, tier = effective.legacy?.modelTier ?? source.model_tier_override;
  if (a.originalContractDigest !== acceptanceDigest(contract) || a.requirementsDigest !== repairRevisionRequirementsDigest(contract)
    || a.taskHash !== acceptanceDigest(source.task) || a.sourceHash !== contract.subjectHash
    || typeof provider !== "string" || !provider.trim() || typeof tier !== "string" || !tier.trim()
    || a.provider !== provider || a.modelTier !== tier
    || !await h.chain(c, input.sourceRunId) || await h.hash(source.root_uri, input.fileScopes) !== a.sourceHash) return null;
  const fingerprint = acceptanceDigest({ failure: input.fingerprint, explicitIndependentReviewApprovalKey: a.approvalKey });
  // All assignment states count. A held/cancelled/failed review never refunds this grant.
  const consumed = await c.query(`select 1 from queue_coordinator_assignments where fingerprint=$1
    union all select 1 from action_receipts where action_type='queue_coordinator_reserved'
    and metadata->>'independentReviewReservationAuthorizationUri'=$2 limit 1`, [fingerprint, uri]);
  return consumed.rowCount ? null : fingerprint;
}
