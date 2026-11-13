import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { userInfo } from "node:os";
import { withClient } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { appendActionReceipt } from "./receipt-writer.js";

export interface RepairGrant {
  version: 1;
  enabled: boolean;
  projectRootUri: string;
  originTaskId: string;
  issuedAt: string;
  expiresAt: string;
  runs: Array<{ runId: string; taskHash: string }>;
}

/** Operator trust material comes from the host, never a callback or run metadata.
 * The pinned envelope digest also prevents restoring an older signed grant after
 * revocation. No runtime API issues grants or accepts a key from a callback.
 */
export async function loadRepairGrant(environment?: NodeJS.ProcessEnv): Promise<RepairGrant | null> {
  try {
    // Production ignores process.env because the CLI loads project-local dotenv
    // files. Explicit settings are for trusted host adapters, never callbacks.
    // userInfo uses the OS account record, not project-overridable HOME/USERPROFILE.
    const settings = environment ?? JSON.parse(await readFile(path.join(userInfo().homedir, ".config", "agent-workflow", "repair-authority.json"), "utf8"));
    const file = settings.AGENTFLOW_REPAIR_GRANT_FILE;
    const keyFile = settings.AGENTFLOW_REPAIR_AUTHORITY_KEY_FILE;
    const digest = settings.AGENTFLOW_REPAIR_GRANT_SHA256;
    if (!file || !keyFile || !path.isAbsolute(file) || !path.isAbsolute(keyFile) || !/^[a-f0-9]{64}$/u.test(digest ?? "")) return null;
    const raw = await readFile(file);
    if (raw.length > 32_768 || createHash("sha256").update(raw).digest("hex") !== digest) return null;
    const envelope = JSON.parse(raw.toString("utf8"));
    if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") return null;
    if (!verify(null, Buffer.from(envelope.payload), await readFile(keyFile), Buffer.from(envelope.signature, "base64"))) return null;
    const grant = JSON.parse(envelope.payload) as RepairGrant;
    const issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt), now = Date.now();
    if (grant.version !== 1 || grant.enabled !== true || !path.isAbsolute(grant.projectRootUri)
      || typeof grant.originTaskId !== "string" || !grant.originTaskId
      || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now
      || expires - issued > 86_400_000 || !Array.isArray(grant.runs) || !grant.runs.length || grant.runs.length > 32
      || grant.runs.some(run => !/^[a-f0-9-]{36}$/iu.test(run.runId) || !/^[a-f0-9]{64}$/u.test(run.taskHash))) return null;
    return grant;
  } catch { return null; }
}

export function repairGrantMatches(grant: RepairGrant | null, run: {
  id: string; task: string; projectRootUri: string; metadata: Record<string, unknown>;
}): boolean {
  if (!grant || grant.projectRootUri !== run.projectRootUri
    || grant.originTaskId !== (run.metadata.codexThreadId ?? run.metadata.originTaskId)
    || ["blocked-run-repair", "workflow-supervisor-repair", "workflow-root-repair"].includes(String(run.metadata.source ?? ""))) return false;
  return grant.runs.some(scope => scope.runId === run.id && scope.taskHash === acceptanceDigest(run.task));
}

/** Polling and callbacks use canonical rows, not payload task/status claims. */
export async function authorizedRepairRun(runId: string, environment?: NodeJS.ProcessEnv): Promise<boolean> {
  const grant = await loadRepairGrant(environment);
  if (!grant) return false;
  return withClient(async client => {
    const result = await client.query<{ id: string; task: string; projectRootUri: string; metadata: Record<string, unknown> }>(
      `select w.id::text,w.task,p.root_uri as "projectRootUri",w.evaluation_metadata as metadata
       from workflow_runs w join projects p on p.id=w.project_id where w.id=$1`, [runId]);
    return Boolean(result.rows[0] && repairGrantMatches(await loadRepairGrant(environment), result.rows[0]));
  });
}

/** Host adapters supply independently authenticated receiver identity, never a
 * body field. This claims permission to inspect/continue existing work only;
 * action policy, approval checks and repair reservations still gate dispatch.
 */
export async function claimAuthorizedCallback(input: { notificationId: string; runId: string; authenticatedTaskId: string },
  environment?: NodeJS.ProcessEnv): Promise<boolean> {
  const grant = await loadRepairGrant(environment);
  if (!grant || input.authenticatedTaskId !== grant.originTaskId) return false;
  return withClient(async client => {
    await client.query("begin");
    try {
      const result = await client.query<{ id: string; task: string; projectRootUri: string; metadata: Record<string, unknown> }>(
        `select w.id::text,w.task,p.root_uri as "projectRootUri",w.evaluation_metadata as metadata
         from workflow_runs w join projects p on p.id=w.project_id join run_notifications n on n.run_id=w.id
         where w.id=$1 and n.id=$2 and n.origin_task_id=$3 and n.kind in ('blocked','failed','completed')
         and ((n.kind='completed' and w.status='completed') or (n.kind=w.status))
         and not exists(select 1 from run_notifications newer where newer.run_id=w.id and newer.channel=n.channel
           and newer.origin_task_id is not distinct from n.origin_task_id and newer.created_at>n.created_at)
         and not exists(select 1 from action_approvals a where a.run_id=w.id and
           (a.status='pending' or (a.status='approved' and a.executed_at is null))) for update of w`,
        [input.runId, input.notificationId, input.authenticatedTaskId]);
      const run = result.rows[0];
      if (!run || !repairGrantMatches(grant, run)) { await client.query("rollback"); return false; }
      // Lock acquisition may wait; expiry/revocation must still hold at mutation.
      const currentGrant = await loadRepairGrant(environment);
      if (!currentGrant || input.authenticatedTaskId !== currentGrant.originTaskId || !repairGrantMatches(currentGrant, run)) {
        await client.query("rollback"); return false;
      }
      const inserted = await client.query(`insert into artifacts(run_id,kind,uri,content)
        values($1,'callback_continuation_claim',$2,$3::jsonb) on conflict(uri) do nothing returning id`,
        [run.id, `db://workflow_runs/${run.id}/callback_continuation_claim/${input.notificationId}`,
          JSON.stringify({ notificationId: input.notificationId, authorityDigest: acceptanceDigest(currentGrant) })]);
      if (!inserted.rowCount) { await client.query("rollback"); return false; }
      await appendActionReceipt(client, { runId: run.id, agentId: "workflow-orchestrator", actionType: "callback_continuation_authorized",
        target: input.notificationId, summary: "Claimed separately authorized callback continuation; no approval or policy bypass.",
        metadata: JSON.stringify({ notificationId: input.notificationId, authorityDigest: acceptanceDigest(currentGrant) }) });
      await client.query("commit");
      return true;
    } catch (error) { await client.query("rollback"); throw error; }
  });
}
