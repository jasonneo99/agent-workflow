import assert from "node:assert/strict";
import test from "node:test";
import { compileContext } from "./index.js";

test("compiled briefs label bounded exact source evidence separately from summaries", async () => {
  const brief = await compileContext({
    task: "repair a blocked source-aware run",
    projectDir: process.cwd(),
    project: { project: { name: "fixture", autonomy: 1 }, execution: { policy_profile: "local" }, actions: { allowed_commands: [], blocked_commands: [], command_timeout_ms: 1, max_output_chars: 1, allowed_write_paths: [], blocked_write_paths: [], max_write_bytes: 1, approval_rules: [] } } as never,
    workflow: { id: "fixture", name: "Fixture", lead: "fixture", stages: [] } as never,
    agents: [],
    sourceExcerpts: [{ sourceUri: "Sources/Feature.swift", content: "struct Feature {}" }]
  });
  assert.match(brief, /## Exact Source Evidence/u);
  assert.match(brief, /### Sources\/Feature\.swift/u);
  assert.match(brief, /struct Feature \{\}/u);
});
