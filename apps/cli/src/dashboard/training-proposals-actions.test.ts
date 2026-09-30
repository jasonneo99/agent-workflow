import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("training proposal actions advance from approval through evaluation and promotion", () => {
  const actions = source.slice(source.indexOf("function renderTrainingProposalActions"), source.indexOf("function renderContextGatewayHtml"));
  assert.match(actions, /item\.status === "pending"[\s\S]+Approve evaluation/u);
  assert.match(actions, /item\.status === "approved"[\s\S]+Record evaluation complete/u);
  assert.match(actions, /item\.status === "evaluated"[\s\S]+Record promotion decision/u);
  assert.match(actions, /item\.status === "promoted"[\s\S]+No further inbox action is required/u);
  assert.doesNotMatch(actions.slice(actions.indexOf('item.status === "approved"'), actions.indexOf('item.status === "evaluated"')), /Approve evaluation/u);
});

test("repeated training proposal decisions report a no-op instead of pretending to change state", () => {
  assert.match(source, /current\?\.status === status[\s\S]+No state change was needed/u);
});
