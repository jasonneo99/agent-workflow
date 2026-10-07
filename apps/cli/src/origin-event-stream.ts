import pg from "pg";
import { createInterface } from "node:readline";
import { databaseUrl } from "../../../packages/storage/src/client.js";

export interface OriginBinding { project?: string; consumer: string; task?: string }
export interface OriginEvent {
  type: "lifecycle"; version: 1; id: string; runId: string; taskId: string | null;
  project: string; channel: string; eventKey: string | null;
  kind: string; title: string; body: string; createdAt: string;
}

export function validateOriginBinding(binding: OriginBinding): void {
  if (!/^[a-zA-Z0-9-]{1,160}$/u.test(binding.consumer)
    || (binding.task !== undefined && !/^[a-zA-Z0-9-]{1,160}$/u.test(binding.task))) {
    throw new Error("A stable local consumer identity and valid optional task filter are required.");
  }
}

export async function readOriginEvents(client: pg.Client, binding: OriginBinding): Promise<OriginEvent[]> {
  validateOriginBinding(binding);
  return (await client.query<OriginEvent>(`
    SELECT 'lifecycle' AS type, 1 AS version, n.id::text, n.run_id::text AS "runId",
      n.origin_task_id AS "taskId",p.root_uri AS project,n.channel,n.event_key AS "eventKey",
      n.kind, n.title, n.body, n.created_at::text AS "createdAt"
    FROM run_notifications n JOIN workflow_runs wr ON wr.id=n.run_id
    JOIN projects p ON p.id=wr.project_id
    WHERE ($1::text IS NULL OR p.root_uri=$1)
      AND ($3::text IS NULL OR n.origin_task_id=$3)
      AND NOT EXISTS (SELECT 1 FROM engine_event_acknowledgments a WHERE a.consumer_id=$2 AND a.notification_id=n.id)
    ORDER BY n.created_at,n.id LIMIT 100`, [binding.project ?? null, binding.consumer, binding.task ?? null])).rows;
}

/** Private child-process stdin is the trust boundary, not an HTTP identity assertion.
 * Only an envelope actually sent on this connection may be acknowledged. */
export async function acknowledgeOriginEvent(client: pg.Client, binding: OriginBinding, event: OriginEvent): Promise<boolean> {
  validateOriginBinding(binding);
  return (await client.query(`INSERT INTO engine_event_acknowledgments(consumer_id,notification_id)
    SELECT $4,n.id FROM run_notifications n JOIN workflow_runs wr ON wr.id=n.run_id
    JOIN projects p ON p.id=wr.project_id WHERE n.id=$1::uuid AND n.run_id=$2::uuid
      AND ($3::text IS NULL OR p.root_uri=$3)
      AND n.origin_task_id IS NOT DISTINCT FROM $5::text AND ($6::text IS NULL OR n.origin_task_id=$6)
    ON CONFLICT (consumer_id,notification_id) DO UPDATE SET acknowledged_at=engine_event_acknowledgments.acknowledged_at`,
  [event.id,event.runId,binding.project ?? null,binding.consumer,event.taskId,binding.task ?? null])).rowCount === 1;
}

export async function runOriginEventStream(binding: OriginBinding): Promise<void> {
  validateOriginBinding(binding);
  const lines = createInterface({ input: process.stdin });
  let stopped = false;
  let wake: (() => void) | undefined;
  let active: pg.Client | undefined;
  const sent = new Map<string, OriginEvent>();
  const stop = (): void => { stopped = true; wake?.(); };
  lines.on("close", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // Serial ACK processing, with failures retained for replay after reconnect.
  let acknowledgments = Promise.resolve();
  lines.on("line", line => {
    acknowledgments = acknowledgments.then(async () => {
      if (line.length > 1024) return;
      let ack: { type?: string; id?: string; runId?: string; taskId?: string | null };
      try { ack = JSON.parse(line); } catch { return; }
      const event = ack && typeof ack.id === "string" ? sent.get(ack.id) : undefined;
      if (!active || !event || ack.type !== "ack" || ack.runId !== event.runId || ack.taskId !== event.taskId) return;
      if (await acknowledgeOriginEvent(active, binding, event)) sent.delete(event.id);
      wake?.();
    }).catch(() => { wake?.(); });
  });
  try {
    while (!stopped) {
      const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
      let failed = false;
      client.on("error", () => { failed = true; wake?.(); });
      let dirty = true;
      client.on("notification", () => { dirty = true; wake?.(); });
      try {
        await client.connect();
        // Listen before replay so commits during the snapshot are not lost.
        await client.query("LISTEN agentflow_origin_events");
        await client.query("LISTEN agentflow_runtime_events");
        active = client;
        sent.clear();
        while (!stopped && !failed) {
          dirty = false;
          const events = await readOriginEvents(client, binding);
          const eligible = new Set(events.map(event => event.id));
          for (const id of sent.keys()) if (!eligible.has(id)) sent.delete(id);
          for (const event of events) {
            sent.set(event.id, event);
            if (!process.stdout.write(`${JSON.stringify(event)}\n`)) {
              await new Promise<void>(resolve => process.stdout.once("drain", resolve));
            }
          }
          if (dirty) continue;
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, 30000);
            function done(): void { clearTimeout(timer); wake = undefined; resolve(); }
            wake = done;
            if (stopped || failed || dirty) done();
          });
        }
      } catch {
        // No database URL or payloads in diagnostics.
        process.stderr.write("Lifecycle stream disconnected; replay will resume.\n");
      } finally {
        active = undefined;
        await acknowledgments;
        await client.end().catch(() => undefined);
      }
      if (!stopped) await new Promise<void>(resolve => {
        const timer = setTimeout(done, 2000);
        function done(): void { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
      });
    }
  } finally {
    lines.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
