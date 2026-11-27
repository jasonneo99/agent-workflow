import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();

test("bulk approval sits after the list as a secondary review link, not among the filters", () => {
  const filters = source.slice(source.indexOf('aria-label="Approval status filters"'), source.indexOf('class="panel approval-inbox-panel"'));
  assert.doesNotMatch(filters, /bulkHref/u);
  assert.match(source, /class="bulk-action-footer"[^`]*<a class="button secondary" href="\$\{escapeHtml\(bulkHref\)\}">Review and approve all \$\{pendingCount\} pending/u);
});

test("removing failed queue cards is collapsed behind a disclosure with a count", () => {
  assert.match(source, /<details class="panel warn-panel bulk-actions">\s*<summary><h2>Clear failed queue items \(\$\{failed\.length\}\)<\/h2><\/summary>/u);
  assert.match(source, /name="confirmed" required/u);
});
