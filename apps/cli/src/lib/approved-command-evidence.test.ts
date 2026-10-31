import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { StructuredAcceptanceContract } from "../../../../packages/model-providers/src/types.js";
import { acceptanceDigest, storedAcceptanceDecision } from "../../../../packages/storage/src/acceptance.js";
import { executeSourceBoundApprovedCommand } from "./approved-command-evidence.js";

function fixture() {
  const contract: StructuredAcceptanceContract = { version: 1, contractId: "contract", originRunId: "run", projectId: "project", taskHash: acceptanceDigest("task"), subjectHash: "source", sourcePaths: ["src.ts"],
    deliverables: [{ id: "original", description: "Full requirement", requiredGates: ["implementation", "verification", "packaging", "supervision"], status: "verified", gaps: [], receipts: {} }] };
  const input = { run: { runId: "run", projectId: "project", projectRootUri: "/synthetic", task: "task", contract }, approvalRunId: "run", approvalProjectRootUri: "/synthetic", localProjectRootUri: "/synthetic", execute: async () => ({ commandLine: "git diff --check", exitCode: 0, timedOut: false }) };
  return { input, contract };
}
test("source-bound approval result supplies exact evidence accepted by all production gates", async () => {
  const { input, contract } = fixture();
  const bound = await executeSourceBoundApprovedCommand(input, async () => "source");
  const content = { ...bound.result, ...bound.evidence, executedFromApprovalId: "approval" }, observedAt = "2026-01-01T00:00:00.000Z";
  const ref = { artifactUri: "db://command", runId: "run", taskId: "task", stageId: "supervision", kind: "command_output" as const, contentHash: acceptanceDigest(content), observedAt, subjectHash: "source" };
  for (const gate of contract.deliverables[0].requiredGates) contract.deliverables[0].receipts[gate] = [ref];
  const c = { query: async (sql: string) => ({ rows: sql.includes("select uri from artifacts") ? [{ uri: ref.artifactUri }] : sql.includes("from workflow_runs where")
    ? [{ projectId: "project", task: "task", metadata: { acceptanceContract: contract } }]
    : [{ runId: "run", taskId: "task", stageId: "supervision", projectId: "project", kind: "command_output", content, observedAt }] }) } as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  for (const gate of contract.deliverables[0].requiredGates) assert.equal((await storedAcceptanceDecision(c, "run", gate, { acceptanceContract: contract })).reason, null);
});
test("pre-execution source drift refuses command dispatch", async () => {
  const { input } = fixture(); let executed = false; input.execute = async () => { executed = true; return { commandLine: "git diff --check", exitCode: 0, timedOut: false }; };
  await assert.rejects(executeSourceBoundApprovedCommand(input, async () => "drift"), /changed before execution/u); assert.equal(executed, false);
});
test("post-execution drift preserves actual result but cannot claim a subject", async () => {
  const { input } = fixture(); let calls = 0;
  const result = await executeSourceBoundApprovedCommand(input, async () => ++calls === 1 ? "source" : "drift");
  assert.equal(result.result.exitCode, 0); assert.equal(result.sourceUnchanged, false); assert.equal(result.evidence.subjectHash, null); assert.equal(result.evidence.sourceAfter, "drift");
});
test("unavailable postimage preserves command failure evidence without inventing a hash", async () => {
  const { input } = fixture(); let calls = 0;
  const result = await executeSourceBoundApprovedCommand(input, async () => { if (++calls > 1) throw Error("unavailable"); return "source"; });
  assert.equal(result.sourceUnchanged, false); assert.equal(result.evidence.sourceAfter, null);
});
test("run/project/task identity mismatches refuse execution", async () => {
  for (const mutate of [(x: ReturnType<typeof fixture>["input"]) => { x.approvalRunId = "other"; }, (x: ReturnType<typeof fixture>["input"]) => { x.approvalProjectRootUri = "/other"; }, (x: ReturnType<typeof fixture>["input"]) => { x.run.contract.taskHash = "other"; }, (x: ReturnType<typeof fixture>["input"]) => { x.run.contract.projectId = "other"; }]) {
    const { input } = fixture(); mutate(input); await assert.rejects(executeSourceBoundApprovedCommand(input, async () => "source"), /identity/u);
  }
});
test("ordinary legacy execution stays unchanged and hashes no inferred scope", async () => {
  const { input } = fixture(); const legacy = { ...input, run: { ...input.run, contract: undefined } };
  const result = await executeSourceBoundApprovedCommand(legacy, async () => { throw Error("No implicit source scope"); });
  assert.deepEqual(result.evidence, {}); assert.equal(result.sourceUnchanged, true);
});

for (const reason of ["expired intent", "wrong child", "wrong fence"]) test(`coordinator ${reason} refuses command before execution`, async () => {
  const { input } = fixture(); let executed = false;
  const owned = { ...input, run: { ...input.run, coordinatorClaimId: "claim", coordinatorFence: "1" },
    execute: async () => { executed = true; return input.execute(); }, assertCoordinatorAuthority: async () => { throw Error(reason); } };
  await assert.rejects(executeSourceBoundApprovedCommand(owned, async () => "source"), new RegExp(reason));
  assert.equal(executed, false);
});
test("coordinator authority lost after execution cannot become acceptance evidence", async () => {
  const { input } = fixture(); let checks = 0;
  const result = await executeSourceBoundApprovedCommand({ ...input, run: { ...input.run, coordinatorClaimId: "claim", coordinatorFence: "1" },
    assertCoordinatorAuthority: async () => { if (++checks > 1) throw Error("expired"); } }, async () => "source");
  assert.equal(checks, 2); assert.equal(result.sourceUnchanged, false); assert.equal(result.evidence.subjectHash, null);
});
test("approval coordinator SQL binds exact child/fence/project/scope/live owner intent", () => {
  const block = readFileSync(new URL("./approved-command-evidence.ts", import.meta.url), "utf8");
  for (const predicate of ["q.id=$1::uuid", "q.fence=$2::bigint", "q.project_id::text=$3::text", "q.child_run_id=$4::uuid", "i.project_id::text=q.project_id::text", "i.owner=q.owner", "i.fencing_token::text=q.intent_fence", "i.file_scopes=q.file_scopes", "i.expires_at>clock_timestamp()"])
    assert.ok(block.includes(predicate), predicate);
});
