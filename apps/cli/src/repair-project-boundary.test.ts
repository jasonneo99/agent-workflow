import assert from "node:assert/strict";
import test from "node:test";
import { automaticRepairProjectAllowed } from "./repair-project-boundary.js";

test("dependency roots cannot be automatic repair destinations", () => {
  for (const root of ["/workspace/fleet/vendor/assistant", "/home/example/fleet/vendor/assistant",
    "/workspace/fleet/vendor/assistant/runtime", "/workspace/node_modules/assistant", "/workspace/Vendor/assistant"])
    assert.equal(automaticRepairProjectAllowed(root), false, root);
});

test("owning projects remain eligible without basename-based authority transfer", () => {
  assert.equal(automaticRepairProjectAllowed("/workspace/assistant"), true);
  assert.equal(automaticRepairProjectAllowed("/workspace/fleet"), true);
  assert.equal(automaticRepairProjectAllowed("/workspace/vendor-tools"), true);
  assert.equal(automaticRepairProjectAllowed("assistant"), false);
});
