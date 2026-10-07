import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceContractSchema } from "./acceptance-schema.js";
import { CodexCliProvider } from "./codex-cli.js";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";

test("acceptance transport schema freezes identity and exposes evidence without weakening object schemas", () => {
  const schema = acceptanceContractSchema({ version: 1, contractId: "c", projectId: "p", originRunId: "r", taskHash: "t", subjectHash: "s", deliverables: [{ id: "d", description: "Verify", requiredGates: ["verification"], status: "pending", receipts: {}, gaps: [] }] });
  const properties = schema.properties as Record<string, any>;
  assert.deepEqual(properties.subjectHash.enum, ["s"]);
  const deliverable = properties.deliverables.items.anyOf[0];
  assert.deepEqual(deliverable.properties.id.enum, ["d"]);
  assert.equal(deliverable.properties.advisory, undefined);
  assert.ok(deliverable.properties.status.enum.includes("blocked"));
  assert.equal(deliverable.properties.receipts.properties.verification.items.properties.contentHash.type, "string");
  const visit = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.enum)) assert.ok(value.enum.every((item: unknown) => item === null || ["string", "number", "boolean"].includes(typeof item)), "Provider enums must contain scalars, never arrays or objects");
    if (value.type === "object") {
      assert.equal(value.additionalProperties, false);
      assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort());
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
});

test("Codex adapter carries enrolled contract through its runner and parsed output", async () => {
  const contract = { version: 1 as const, contractId: "c", projectId: "p", originRunId: "r", taskHash: "t", subjectHash: "s", deliverables: [{ id: "d", description: "Verify", requiredGates: ["verification" as const], status: "pending" as const, receipts: { implementation: [], verification: [], packaging: [], supervision: [] }, gaps: [] }] };
  const provider = new CodexCliProvider({
    async authStatus() { return "Logged in using ChatGPT"; },
    async execute(input) {
      assert.ok((input.schema.required as string[]).includes("acceptanceContract"));
      assert.ok(input.prompt.includes(JSON.stringify(contract)));
      return { model: "synthetic", output: JSON.stringify({ outcome: "completed", summary: "Evidence requested", acceptanceContract: contract }) };
    }
  });
  const result = await provider.executeStage({ runId: "r", taskId: "t", workflowId: "build-feature", workflowTask: "Verify", stageId: "verify", stageGoal: "Verify", agentId: "test-engineer", agentName: "Test", agentPrompt: "Verify", compiledBrief: "", projectConfig: projectConfigSchema.parse({ project: { name: "synthetic" } }), priorReceipts: [], acceptanceContract: contract });
  assert.deepEqual(result.artifact.acceptanceContract, contract);
});
