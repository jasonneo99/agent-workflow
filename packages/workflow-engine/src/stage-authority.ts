import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import type { StageAuthorityGrant } from "../../guarded-autonomy/src/index.js";
import { assertStageAuthority, issueStageAuthorityGrant } from "../../storage/src/postgres.js";

export async function createRenewingStageAuthority(input: {
  projectId: string;
  runId: string;
  stageId: string;
  workflowId: string;
  agentId: string;
  providerId: string;
  project: ProjectConfig;
  evidence: string;
  leaseSeconds: number;
  assertLeaseOwned: () => Promise<void>;
}): Promise<(mutation: boolean) => Promise<void>> {
  let grant: StageAuthorityGrant | null = null;
  const renew = async (): Promise<void> => {
    await input.assertLeaseOwned();
    grant = await issueStageAuthorityGrant({
      projectId: input.projectId,
      runId: input.runId,
      stageId: input.stageId,
      workflowId: input.workflowId,
      agentId: input.agentId,
      providerId: input.providerId,
      policySnapshot: input.project,
      evidence: input.evidence,
      expiresAt: new Date(Date.now() + input.leaseSeconds * 1000).toISOString(),
      mutationAllowed: true
    });
  };
  await renew();
  return async (mutation: boolean): Promise<void> => {
    await input.assertLeaseOwned();
    if (!grant || Date.parse(grant.expires_at) <= Date.now() + 30_000) await renew();
    await assertStageAuthority({ grant: grant!, mutation });
  };
}
