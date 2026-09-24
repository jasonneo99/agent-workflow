import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLookup, normalizeProviderRef, resolveAgent, resolveWorkflow } from "./reference-resolution.js";

test("resolveWorkflow preserves aliases, exact lookup, and case sensitivity", () => {
  const workflows = [{ id: "review-pr" }, { id: "build-feature" }];

  assert.equal(resolveWorkflow(workflows, "review"), workflows[0]);
  assert.equal(resolveWorkflow(workflows, "build-feature"), workflows[1]);
  assert.equal(resolveWorkflow(workflows, "Review"), undefined);
  assert.equal(resolveWorkflow(workflows, "unknown"), undefined);
});

test("resolveWorkflow preserves byId duplicate semantics", () => {
  const first = { id: "review-pr", version: 1 };
  const last = { id: "review-pr", version: 2 };

  assert.equal(resolveWorkflow([first, last], "review"), last);
});

test("resolveAgent applies aliases before normalized display-name and id fallbacks", () => {
  const aliasTarget = { id: "ux-reviewer", display_name: "Mira" };
  const displayTarget = { id: "custom-agent", display_name: "Release Coach" };
  const idTarget = { id: "mixed-case-agent", display_name: "Something Else" };

  assert.equal(resolveAgent([aliasTarget, displayTarget, idTarget], "UX Pass"), aliasTarget);
  assert.equal(resolveAgent([aliasTarget, displayTarget, idTarget], "release coach"), displayTarget);
  assert.equal(resolveAgent([aliasTarget, displayTarget, idTarget], "Mixed Case Agent"), idTarget);
  assert.equal(resolveAgent([aliasTarget], "unknown"), undefined);
});

test("resolveAgent preserves exact duplicate-id precedence", () => {
  const first = { id: "backend-engineer", display_name: "First" };
  const last = { id: "backend-engineer", display_name: "Last" };

  assert.equal(resolveAgent([first, last], "backend"), last);
});

test("normalizeLookup produces stable lookup keys", () => {
  assert.equal(normalizeLookup("  LM Studio / Local  "), "lm-studio-local");
  assert.equal(normalizeLookup("---"), "");
});

test("normalizeProviderRef maps aliases and normalizes unknown providers", () => {
  assert.equal(normalizeProviderRef("ChatGPT Codex"), "chatgpt-codex");
  assert.equal(normalizeProviderRef("Codex"), "codex-cli");
  assert.equal(normalizeProviderRef("LM Studio"), "local");
  assert.equal(normalizeProviderRef("Bring Your Own Model"), "byo");
});
