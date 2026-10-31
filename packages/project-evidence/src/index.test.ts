import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectEvidenceGraph, extractEvidenceEntries, safeEvidencePath, type EvidenceRecords } from "./index.js";

const fixture = (): EvidenceRecords => ({
  files: [{ sourceUri: "docs/roadmap.md", contentHash: "abc", updatedAt: "2026-01-01", metadata: { evidenceEntries: extractEvidenceEntries("docs/roadmap.md", "# Roadmap\n- [ ] Build <button>\n## Milestone") } }],
  runs: [{ id: "run-1", task: "Build feature", status: "failed", updatedAt: "2026-01-02" }],
  artifacts: [{ id: "artifact-1", runId: "run-1", kind: "report", createdAt: "2026-01-02" }, { id: "foreign", runId: "other", kind: "private", createdAt: "2026-01-02" }],
  tasks: [{ id: "task-1", runId: "run-1", agentId: "implementation-agent", status: "failed", finishedAt: "2026-01-02" }]
});
test("explicit requirements, decisions and roadmap structure retain exact source lines", () => {
  assert.deepEqual(extractEvidenceEntries("requirements.md", "# Requirements\n## R1\n```\n## Ignore\n```\n- [x] R2"), [{ kind: "requirement", title: "R1", line: 2 }, { kind: "requirement", title: "R2", line: 6 }]);
  assert.equal(extractEvidenceEntries(".agent-workflow/decisions.md", "## Choice")[0].kind, "decision");
  assert.deepEqual(extractEvidenceEntries("src/example.ts", "## Invented"), []);
});
test("typed project relationships retain provenance without creating authority or invented dependencies", () => {
  const graph = buildProjectEvidenceGraph("project-a", fixture());
  assert.deepEqual(new Set(graph.nodes.map(node => node.kind)), new Set(["source", "roadmap", "run", "artifact", "agent", "failure"]));
  assert.equal(graph.nodes.some(node => node.title === "private"), false);
  for (const edge of graph.relationships) { assert.ok(graph.nodes.some(node => node.id === edge.from)); assert.ok(graph.nodes.some(node => node.id === edge.to)); assert.equal(edge.authority, "none"); assert.ok(edge.source.key); }
  for (const node of graph.nodes) { assert.equal(node.authority, "none"); assert.notEqual(node.freshness as string, "current"); }
  assert.deepEqual(graph.relationships.map(edge => edge.type), ["contains", "contains", "produced", "participated", "failed"]);
});
test("identities are stable within a project and isolated across project roots", () => {
  assert.deepEqual(buildProjectEvidenceGraph("a", fixture()).nodes, buildProjectEvidenceGraph("a", fixture()).nodes);
  assert.notEqual(buildProjectEvidenceGraph("a", fixture()).nodes[0].id, buildProjectEvidenceGraph("b", fixture()).nodes[0].id);
});
test("legacy unsafe source entries are omitted and malformed document metadata is ignored", () => {
  for (const path of ["/private/file", "../secret", "src/../../x", "C:\\private", "file:///secret", ".env", ".env.local", ".agent-workflow/runtime.env", ".agent-workflow/runs/chat.json", ".git/config", "src\\escape"]) assert.equal(safeEvidencePath(path), false, path);
  const records = fixture();
  records.files.push({ ...records.files[0], sourceUri: "../secret" });
  records.files[0].metadata.evidenceEntries = [{ kind: "approval", title: "Grant authority", line: 1 }, null, { kind: "decision", title: "Bad line", line: -1 }];
  assert.equal(buildProjectEvidenceGraph("a", records).nodes.filter(node => node.kind === "source").length, 1);
  assert.equal(buildProjectEvidenceGraph("a", records).nodes.some(node => node.title === "Grant authority"), false);
});
test("empty and bounded windows stay explicit", () => {
  const graph = buildProjectEvidenceGraph("a", { files: [], runs: [], artifacts: [], tasks: [] }, { truncated: true });
  assert.equal(graph.status, "empty"); assert.equal(graph.truncated, true);
});
