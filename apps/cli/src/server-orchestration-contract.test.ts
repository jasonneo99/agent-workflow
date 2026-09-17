import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("server orchestration accepts one goal and queues one dynamic lifecycle", () => {
  assert.match(source, /request\.method === "POST" && requestUrl\.pathname === "\/api\/server-orchestrations"/u);
  assert.match(source, /constructDynamicWorkflow\(\{ goal, project/u);
  assert.match(source, /seedRegistry\(\[\], \[\{ path: `runtime\/\$\{workflow\.id\}\.yaml`, value: workflow \}\]\)/u);
  assert.match(source, /registeredProjectRootUri: summary\.rootUri/u);
  assert.match(source, /projectRootUri: input\.registeredProjectRootUri \?\? projectDir/u);
  assert.match(source, /actionType: "server_orchestration_requested"/u);
  assert.match(source, /source: "server-orchestration"/u);
  assert.match(source, /executionProfile: "adaptive"/u);
});

test("legacy server queue requests default to adaptive execution", () => {
  assert.match(source, /const requestedExecutionProfile = stringValue\(payload\.executionProfile\) === "full" \? "full" : "adaptive"/u);
  assert.match(source, /workflowOverride: adaptiveWorkflow \?\? undefined/u);
  assert.match(source, /requestedWorkflowId: routePreview\.route\.workflowId/u);
});

test("orchestration status propagates blocked runs to the aggregate", () => {
  assert.match(source, /statuses\.includes\("blocked"\) \? "blocked"/u);
  assert.match(source, /\/api\/server-orchestration-status/u);
  assert.match(source, /progress: ServerOrchestrationStatusReport\["progress"\]/u);
  assert.match(source, /pendingApprovals/u);
  assert.match(source, /result = serverOrchestrationStatusIsTerminal\(status\)/u);
});

test("orchestration exposes bounded authenticated progress events", () => {
  assert.match(source, /requestUrl\.pathname === "\/api\/server-orchestration-events"/u);
  assert.match(source, /"content-type": "text\/event-stream; charset=utf-8"/u);
  assert.match(source, /Date\.now\(\) - startedAt >= 60_000/u);
  assert.match(source, /currentStages: tasks[\s\S]+\.slice\(0, 8\)/u);
  assert.match(source, /links: \{[\s\S]+events: `\/api\/server-orchestration-events/u);
});
