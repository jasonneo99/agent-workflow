import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceDigest, acceptanceGate, acceptancePreflight, acceptanceProposal, enrollAcceptanceContract, storedAcceptanceDecision, historicalCheckpointAcceptanceDecision } from "./acceptance.js";
import type { StructuredAcceptanceContract } from "../../model-providers/src/types.js";
import { structuredAcceptanceDecision } from "../../model-providers/src/quality.js";

function fixture(): StructuredAcceptanceContract {
  return { version: 1, contractId: "contract", projectId: "project", originRunId: "run", taskHash: acceptanceDigest("task"), subjectHash: "subject",
    deliverables: [{ id: "delivery", description: "Synthetic delivery", requiredGates: ["implementation", "verification", "packaging", "supervision"], status: "verified", receipts: {}, gaps: [] }] };
}

test("supervision stages share the structured gate while advisory stages remain unmapped", () => {
  for (const stage of ["supervise", "supervision", "supervisor"]) assert.equal(acceptanceGate(stage), "supervision");
  assert.equal(acceptanceGate("implement-item-1"), "implementation");
  assert.equal(acceptanceGate("verify_item_1"), "verification");
  assert.equal(acceptanceGate("package-product"), "packaging");
  assert.equal(acceptanceGate("supervisor-audit"), "supervision");
  assert.equal(acceptanceGate("implementationNotes"), null);
  for (const stage of ["orient", "plan", "document"]) assert.equal(acceptanceGate(stage), null);
});

test("frozen acceptance requirements cannot be removed or changed by the provider", () => {
  const frozen = fixture();
  assert.ok(acceptanceProposal(frozen, structuredClone(frozen)));
  const changed = structuredClone(frozen);
  changed.deliverables = [];
  assert.equal(acceptanceProposal(frozen, changed), null);
  changed.deliverables = structuredClone(frozen.deliverables);
  changed.subjectHash = "different";
  assert.equal(acceptanceProposal(frozen, changed), null);
  assert.equal(acceptanceDigest({ a: 1, b: 2 }), acceptanceDigest({ b: 2, a: 1 }));
});

test("storage acceptance distinguishes legacy from missing structured evidence at every gate", async () => {
  const frozen = fixture();
  const client = (metadata: Record<string, unknown>) => ({ query: async () => ({ rows: [{ projectId: "project", task: "task", metadata }] }) }) as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  assert.deepEqual(await storedAcceptanceDecision(client({}), "run", "supervision", {}), { mode: "legacy", reason: null });
  assert.match((await storedAcceptanceDecision(client({}), "run", "supervision", { acceptanceContract: frozen })).reason!, /cannot enroll/u);
  for (const gate of ["implementation", "verification", "packaging", "supervision"] as const) {
    assert.match((await storedAcceptanceDecision(client({ acceptanceContract: frozen }), "run", gate, {})).reason!, /identity/u);
    assert.match((await storedAcceptanceDecision(client({ acceptanceContract: frozen }), "run", gate, { acceptanceContract: frozen })).reason!, /lacks/u);
    assert.match((await storedAcceptanceDecision(client({ acceptanceContract: frozen }), "other", gate, { acceptanceContract: frozen })).reason!, /ancestry/u);
  }
});

test("all production gates resolve command identity and content rather than trusting supplied receipts", async () => {
  const content = { commandLine: "npm test", exitCode: 0, timedOut: false, subjectHash: "subject" };
  const frozen = fixture();
  const observedAt = "2026-01-01T00:00:00.000Z";
  const reference = { artifactUri: "db://synthetic/check", runId: "run", taskId: "task", stageId: "verify", kind: "command_output" as const,
    contentHash: acceptanceDigest(content), observedAt, subjectHash: "subject" };
  for (const gate of frozen.deliverables[0].requiredGates) frozen.deliverables[0].receipts[gate] = [reference];
  const client = (override: Record<string, unknown> = {}, latestUri = reference.artifactUri) => ({ query: async (sql: string) => ({ rows: sql.includes("select uri from artifacts") ? [{ uri: latestUri }] : sql.includes("from workflow_runs where")
    ? [{ projectId: "project", task: "task", metadata: { acceptanceContract: frozen } }]
    : [{ runId: "run", taskId: "task", stageId: "verify", projectId: "project", kind: "command_output", content, observedAt, ...override }] }) }) as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  for (const gate of frozen.deliverables[0].requiredGates) {
    assert.equal((await storedAcceptanceDecision(client(), "run", gate, { acceptanceContract: frozen })).reason, null);
    assert.notEqual((await storedAcceptanceDecision(client({}, "db://synthetic/newer-failure"), "run", gate, { acceptanceContract: frozen })).reason, null);
    for (const bad of [{ runId: "other" }, { taskId: "other" }, { projectId: "other" }, { kind: "stage_output" },
      { content: { ...content, commandLine: undefined } }, { content: { ...content, commandLine: " " } },
      { content: { ...content, exitCode: 1 } }, { content: { ...content, subjectHash: "old" } }]) {
      assert.notEqual((await storedAcceptanceDecision(client(bad), "run", gate, { acceptanceContract: frozen })).reason, null);
    }
  }
});

test("historical acceptance derives cutoff from exact completion attestation and never changes current checks", async () => {
  const frozen = fixture();
  const content = { commandLine: "npm test", exitCode: 0, timedOut: false, subjectHash: "subject" };
  const reference = { artifactUri: "db://synthetic/check", runId: "run", taskId: "task", stageId: "verify", kind: "command_output" as const,
    contentHash: acceptanceDigest(content), observedAt: "2026-01-01T00:00:00.000Z", subjectHash: "subject" };
  frozen.deliverables[0].receipts.verification = [reference];
  const artifact = { acceptanceContract: frozen };
  const cutoff = "2026-01-01 00:00:01.123456+00";
  const client = (metadata = artifact, completedAt = cutoff, latest = reference.artifactUri, future = false) => ({ query: async (sql: string, args: unknown[]) => {
    if (sql.includes("action_receipts")) return { rows: [{ metadata, completedAt }] };
    if (sql.includes("from workflow_runs where")) return { rows: [{ projectId: "project", task: "task", metadata: { acceptanceContract: frozen } }] };
    assert.match(sql, /\$3::timestamptz/u);
    assert.ok(args[2] === cutoff || args[2] === null);
    if (sql.includes("select uri from artifacts")) return { rows: [{ uri: args[2] ? latest : "db://synthetic/newer" }] };
    return { rows: future ? [] : [{ runId: "run", taskId: "task", stageId: "verify", projectId: "project", kind: "command_output", content, observedAt: reference.observedAt }] };
  } }) as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  assert.equal((await historicalCheckpointAcceptanceDecision(client(), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await storedAcceptanceDecision(client(), "run", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client({ acceptanceContract: fixture() }), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client(artifact, "invalid"), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client(artifact, cutoff, "db://synthetic/newer-before-completion"), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client(artifact, cutoff, reference.artifactUri, true), "run", "task", "verification", artifact)).reason, null);
});

test("enrollment freezes pending requirements before execution and rejects replacement", async () => {
  const contract = fixture();
  contract.deliverables[0].status = "pending";
  let writes = 0;
  const makeClient = (started: boolean, metadata: Record<string, unknown> = {}) => ({ query: async (sql: string) => {
    if (sql.startsWith("update")) { writes++; return { rows: [] }; }
    return { rows: [{ projectId: "project", task: "task", metadata, started }] };
  } }) as unknown as Parameters<typeof enrollAcceptanceContract>[0];
  await enrollAcceptanceContract(makeClient(false), "run", contract);
  assert.equal(writes, 1);
  await enrollAcceptanceContract(makeClient(false, { acceptanceContract: contract }), "run", contract);
  assert.equal(writes, 1);
  await assert.rejects(enrollAcceptanceContract(makeClient(true), "run", contract), /unstarted/u);
  await assert.rejects(enrollAcceptanceContract(makeClient(false, { acceptanceContract: { ...contract, subjectHash: "old" } }), "run", contract), /immutable/u);
  await assert.rejects(enrollAcceptanceContract(makeClient(false), "other", contract), /matching run identity/u);
  const legacy = await acceptancePreflight(makeClient(false), "run", {});
  assert.equal(legacy.accepted, false);
  assert.equal(legacy.decisions.length, 4);
});

test("only frozen advisory criteria warn or inform; required criteria and invalid evidence block", async () => {
  const contract = fixture();
  for (const severity of ["warn", "info"] as const) {
    contract.deliverables[0].advisory = true;
    contract.deliverables[0].severity = severity;
    const decision = await structuredAcceptanceDecision(contract, "verification", async () => null);
    assert.equal(decision.reason, null);
    assert.equal(decision.findings[0].severity, severity);
    assert.equal(decision.findings[0].deliverableId, "delivery");
    const downgraded = structuredClone(contract);
    downgraded.deliverables[0].severity = "block";
    assert.equal(acceptanceProposal(downgraded, contract), null);
  }
  contract.deliverables[0].advisory = false;
  assert.notEqual((await structuredAcceptanceDecision(contract, "verification", async () => null)).reason, null);
  contract.deliverables[0].advisory = true;
  contract.deliverables[0].receipts.verification = [{ artifactUri: "db://missing", runId: "run", taskId: "task", stageId: "verify", kind: "command_output", contentHash: "hash", observedAt: "2026-01-01T00:00:00.000Z", subjectHash: "subject" }];
  assert.notEqual((await structuredAcceptanceDecision(contract, "verification", async () => null)).reason, null);
  contract.deliverables[0].status = "pending";
  assert.notEqual((await structuredAcceptanceDecision(contract, "verification", async () => null)).reason, null);
});
