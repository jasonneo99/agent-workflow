import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("dashboard exposes a unified redacted activity timeline and API", () => {
  assert.match(source, /requestUrl\.pathname === "\/activity"/u);
  assert.match(source, /requestUrl\.pathname === "\/api\/activity"/u);
  assert.match(source, /One chronological, redacted view/u);
  assert.match(source, /Prompt bodies, model response bodies, credentials, private file contents/u);
  assert.match(source, /\["activity", "\/activity", "Activity", "list"\]/u);
});

test("activity aggregation includes durable and project-local event sources", () => {
  for (const sourceName of [
    "workflow_runs",
    "workflow_tasks",
    "action_receipts",
    "action_approvals",
    "learning/action-receipts.json",
    "learning/daemon-status.json",
    "learning/roadmap-snapshot-publication.json",
    "runtime/server/request-log.jsonl"
  ]) assert.match(source, new RegExp(sourceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
