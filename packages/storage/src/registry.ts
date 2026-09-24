import { createHash } from "node:crypto";
import type { AgentCard, WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import type { RegistryRecord } from "../../agent-registry/src/loaders.js";
import { withClient } from "./client.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function workflowDefinitionHash(definition: unknown): string {
  return createHash("sha256").update(stableJson(definition)).digest("hex");
}

export async function seedRegistry(
  agents: RegistryRecord<AgentCard>[],
  workflows: RegistryRecord<WorkflowDefinition>[]
): Promise<{ agents: number; workflows: number }> {
  return withClient(async (client) => {
    for (const record of agents) {
      await client.query(
        `insert into agents (id, display_name, category, source_path, definition, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (id) do update
         set display_name = excluded.display_name,
             category = excluded.category,
             source_path = excluded.source_path,
             definition = excluded.definition,
             updated_at = now()`,
        [record.value.id, record.value.display_name, record.value.category, record.path, JSON.stringify(record.value)]
      );
    }
    for (const record of workflows) {
      await client.query(
        `insert into workflows (id, name, source_path, definition, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (id) do update
         set name = excluded.name,
             source_path = excluded.source_path,
             definition = excluded.definition,
             updated_at = now()`,
        [record.value.id, record.value.name, record.path, JSON.stringify(record.value)]
      );
    }
    return { agents: agents.length, workflows: workflows.length };
  });
}
