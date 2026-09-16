import assert from "node:assert/strict";
import test from "node:test";
import { buildClientCapabilityContract } from "./index.js";

test("client capability contract is versioned and keeps orchestration authoritative", () => {
  const contract = buildClientCapabilityContract("0.4.6");
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.runtimeVersion, "0.4.6");
  assert.equal(contract.capabilities["orchestration.one-goal"].supported, true);
  assert.equal(contract.capabilities["workflow.client-side-execution"].supported, false);
  assert.equal(contract.capabilities["approval.remote-mutation"].supported, false);
});

test("client capability contract rejects unversioned runtimes", () => {
  assert.throws(() => buildClientCapabilityContract("development"), /semantic runtime version/u);
});
