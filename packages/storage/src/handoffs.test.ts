import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertWorkflowHandoffTransition, workflowDefinitionHash } from "./postgres.js";

test("workflow definition hashes are deterministic across object key order", () => {
  assert.equal(
    workflowDefinitionHash({ version: "2", stages: [{ id: "build", routing: { provider: "mock", tier: "fast" } }] }),
    workflowDefinitionHash({ stages: [{ routing: { tier: "fast", provider: "mock" }, id: "build" }], version: "2" })
  );
});

test("handoff lifecycle accepts retries but protects terminal completion", () => {
  assert.doesNotThrow(() => assertWorkflowHandoffTransition("proposed", "accepted"));
  assert.doesNotThrow(() => assertWorkflowHandoffTransition("accepted", "retrying"));
  assert.doesNotThrow(() => assertWorkflowHandoffTransition("failed", "retrying"));
  assert.doesNotThrow(() => assertWorkflowHandoffTransition("retrying", "completed"));
  assert.throws(() => assertWorkflowHandoffTransition("proposed", "completed"), /Invalid workflow handoff transition/u);
  assert.throws(() => assertWorkflowHandoffTransition("completed", "retrying"), /Invalid workflow handoff transition/u);
});

test("storage bootstrap and migration retain durable handoff history and workflow provenance", () => {
  const postgres = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const bootstrap = readFileSync(new URL("../../../infra/init.sql", import.meta.url), "utf8");
  for (const source of [postgres, bootstrap]) {
    assert.match(source, /workflow_definition_version/u);
    assert.match(source, /workflow_definition_hash/u);
    assert.match(source, /construction_rationale/u);
    assert.match(source, /CREATE TABLE IF NOT EXISTS workflow_handoffs/iu);
    assert.match(source, /CREATE TABLE IF NOT EXISTS workflow_handoff_events/iu);
    assert.match(source, /CREATE TABLE IF NOT EXISTS workflow_handoff_receipts/iu);
  }
  assert.match(postgres, /for update/u);
  assert.match(postgres, /where ar\.id = \$2 and ar\.run_id = \$3/u);
  assert.match(postgres, /stage->'routing'->>'provider'/u);
  assert.match(postgres, /stage->'routing'->>'model_tier'/u);
});
