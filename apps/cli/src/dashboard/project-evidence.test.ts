import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectEvidenceGraph } from "../../../../packages/project-evidence/src/index.js";
import { renderProjectEvidenceHtml } from "./project-evidence.js";
test("context list/detail escapes indexed text and exposes source and relationship navigation", () => {
  const graph = buildProjectEvidenceGraph("/example/project", { files: [{ sourceUri: "docs/roadmap.md", contentHash: "abc", updatedAt: "yesterday", metadata: { evidenceEntries: [{ kind: "roadmap", title: '<script>alert("x")</script>', line: 2 }] } }], runs: [], tasks: [], artifacts: [] });
  const html = renderProjectEvidenceHtml(graph, { selected: graph.nodes[1].id });
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>"));
  assert.match(html, /aria-labelledby="detail-title"/); assert.match(html, /line 2/); assert.match(html, /Relationships \(1\)/); assert.match(html, /project_files/); assert.match(html, /unverified/); assert.match(html, /Open source file/);
  const filtered = renderProjectEvidenceHtml(graph, { kind: "failure" });
  assert.match(filtered, /No evidence matches this filter/);
});
test("storage failures, empty indexes, truncation and missing selections are distinct", () => {
  const graph = buildProjectEvidenceGraph("example", { files: [], runs: [], tasks: [], artifacts: [] });
  assert.match(renderProjectEvidenceHtml(graph), /No indexed evidence found/);
  assert.match(renderProjectEvidenceHtml({ ...graph, status: "unavailable" }), /role="alert"/);
  assert.match(renderProjectEvidenceHtml({ ...graph, truncated: true }), /bounded evidence window/);
  assert.match(renderProjectEvidenceHtml(graph, { selected: "missing" }), /no longer exists/);
});
