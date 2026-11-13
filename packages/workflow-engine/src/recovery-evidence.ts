import { withClient } from "../../storage/src/client.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export function recoveryLinks(metadata: Record<string, unknown>, task = ""): string[] {
  // Legacy operator orchestration records its explicit source list in the
  // frozen goal, not metadata. This permits reading same-project evidence only.
  const sourceList = metadata.source === "server-orchestration" && metadata.actorRole === "operator"
    ? task.slice(0, 2000).match(/Source items: ([^\n]+)/u)?.[1] ?? "" : "";
  const listed = sourceList.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/giu) ?? [];
  return [...new Set([metadata.sourceRunId, metadata.replayOfRunId, metadata.repairOriginRunId, ...listed]
    .filter((id): id is string => typeof id === "string" && uuid.test(id)))].slice(0, 3);
}

export function recoveryText(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[^\s"']+)/giu,"[redacted]")
    .replace(/\b([A-Z_]*(?:KEY|TOKEN|PASSWORD|SECRET)[A-Z_]*)\s*[=:]\s*[^\s,;]+/gu,"$1=[redacted]").slice(0, limit);
}

export function recoveryExitCode(value: unknown): number | null {
  if (typeof value !== "string" || !/^-?\d{1,10}$/u.test(value)) return null;
  const code=Number(value);
  return Number.isInteger(code) && code>=-2147483648 && code<=2147483647 ? code : null;
}

/** Read-only contextual evidence, never an authority or a completion decision.
 * Links come from durable metadata or an explicit operator orchestration source
 * list, never from a provider's current response or arbitrary UUID mentions.
 * Raw command output and environment/config payloads are intentionally excluded.
 */
export async function recoveryEvidence(runId: string, projectRootUri: string): Promise<string> {
  return withClient(async client => {
    const root = (await client.query(`SELECT wr.project_id,wr.evaluation_metadata,left(wr.task,2000) task FROM workflow_runs wr
      JOIN projects p ON p.id=wr.project_id WHERE wr.id=$1::uuid AND p.root_uri=$2`,[runId,projectRootUri])).rows[0];
    if (!root) return "";
    const pending = recoveryLinks(root.evaluation_metadata ?? {},root.task);
    const seen = new Set([runId]);
    const packets: unknown[] = [];
    while (pending.length && packets.length < 3) {
      const id = pending.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const source = (await client.query(`SELECT id,status,left(task,1500) task,evaluation_metadata
        FROM workflow_runs WHERE id=$1::uuid AND project_id=$2`,[id,root.project_id])).rows[0];
      if (!source) { packets.push({runId:id,status:"unavailable-or-out-of-project"}); continue; }
      const receipts = (await client.query(`SELECT action_type,left(summary,1200) summary,created_at
        FROM action_receipts WHERE run_id=$1::uuid AND action_type IN
        ('stage_failed','stage_blocked','stage_cancelled','workflow_run_cancelled','local_command','file_write_rejected')
        ORDER BY created_at DESC LIMIT 4`,[id])).rows;
      const references = (await client.query(`SELECT left(uri,500) uri,kind,
        CASE WHEN jsonb_typeof(content->'exitCode')='number' AND length(content->>'exitCode')<=11
          THEN content->>'exitCode' ELSE NULL END AS exit_code
        FROM artifacts WHERE run_id=$1::uuid AND kind IN ('command_output','stage_output')
        ORDER BY created_at DESC LIMIT 4`,[id])).rows;
      packets.push({runId:id,status:source.status,task:recoveryText(source.task,1500),
        receipts:receipts.map(r=>({action:r.action_type,summary:recoveryText(r.summary,1200),at:r.created_at})),
        references:references.map(r=>({uri:String(r.uri).slice(0,500),kind:r.kind,exitCode:recoveryExitCode(r.exit_code)}))});
      pending.push(...recoveryLinks(source.evaluation_metadata ?? {},source.task));
    }
    if (!packets.length) return "";
    return "Recovery source evidence (read-only; no permissions or acceptance implied):\n" + JSON.stringify(packets);
  });
}
