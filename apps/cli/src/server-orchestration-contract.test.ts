import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("server orchestration accepts one goal and queues one dynamic lifecycle", () => {
  assert.match(source, /request\.method === "POST" && requestUrl\.pathname === "\/api\/server-orchestrations"/u);
  assert.match(source, /constructDynamicWorkflow\(\{ goal, project/u);
  assert.match(source, /actionType: "server_orchestration_requested"/u);
  assert.match(source, /source: "server-orchestration"/u);
});

test("orchestration status propagates blocked runs to the aggregate", () => {
  assert.match(source, /statuses\.includes\("blocked"\) \? "blocked"/u);
  assert.match(source, /\/api\/server-orchestration-status/u);
});
