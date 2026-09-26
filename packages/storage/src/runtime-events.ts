import pg from "pg";
import { databaseUrl } from "./client.js";

const CHANNEL = "agentflow_runtime_events";

export const runtimeEventFunctionSql = `
  CREATE OR REPLACE FUNCTION agentflow_emit_runtime_event() RETURNS trigger AS $$
  BEGIN
    PERFORM pg_notify('agentflow_runtime_events', json_build_object(
      'table', TG_TABLE_NAME, 'operation', TG_OP, 'id', NEW.id, 'status', NEW.status
    )::text);
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;
export const workflowTaskEventTriggerSql = `
  DROP TRIGGER IF EXISTS workflow_tasks_runtime_event ON workflow_tasks;
  CREATE TRIGGER workflow_tasks_runtime_event AFTER INSERT OR UPDATE OF status, available_at ON workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION agentflow_emit_runtime_event();
`;
export const actionApprovalEventTriggerSql = `
  DROP TRIGGER IF EXISTS action_approvals_runtime_event ON action_approvals;
  CREATE TRIGGER action_approvals_runtime_event AFTER INSERT OR UPDATE OF status ON action_approvals
  FOR EACH ROW EXECUTE FUNCTION agentflow_emit_runtime_event();
`;

export type WorkflowEventSubscriber = {
  wait(timeoutMs: number): Promise<"event" | "timeout">;
  close(): Promise<void>;
};

export async function createWorkflowEventSubscriber(): Promise<WorkflowEventSubscriber> {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5_000 });
  await client.connect();
  await client.query(`listen ${CHANNEL}`);
  let pendingEvents = 0;
  const waiters = new Set<() => void>();
  client.on("notification", () => {
    pendingEvents += 1;
    for (const wake of waiters) wake();
    waiters.clear();
  });
  client.on("error", () => {
    for (const wake of waiters) wake();
    waiters.clear();
  });
  return {
    wait: async (timeoutMs) => {
      if (pendingEvents > 0) {
        pendingEvents -= 1;
        return "event";
      }
      return new Promise<"event" | "timeout">((resolve) => {
        let settled = false;
        const finish = (value: "event" | "timeout") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(value);
        };
        const wake = () => {
          if (pendingEvents > 0) pendingEvents -= 1;
          finish("event");
        };
        const timer = setTimeout(() => finish("timeout"), Math.max(10, timeoutMs));
        waiters.add(wake);
      });
    },
    close: async () => {
      await client.query(`unlisten ${CHANNEL}`).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  };
}
