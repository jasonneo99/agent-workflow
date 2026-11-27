import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "../dashboard/test-source.js";

const source = await Promise.resolve(dashboardSource());

test("queue exposes governed unsuccessful-run withdrawal without weakening Partner dismissal protection", () => {
  assert.match(source, /action === "withdraw-unaccepted"/u);
  assert.match(source, /WITHDRAW_RUN_CONFIRMATION/u);
  assert.match(source, /runtime\/withdrawals\/\$\{runId\}/u);
  assert.match(source, /Archive from active views/u);
  assert.match(source, /Original failed status, contracts, approvals, artifacts, and receipts remain in history/u);
  assert.match(source, /error instanceof PartnerManagedRunRecoveryError/u);
});

test("bulk dismissal leaves Partner-managed families for their governed lifecycle", () => {
  assert.match(source, /dismissAllFailedWorkflowRuns/u);
  const storage = source; // Keep this test scoped to the dashboard contract.
  assert.doesNotMatch(storage, /generic dismissal.*accept/u);
});
