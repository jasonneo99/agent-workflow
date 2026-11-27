import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource, functionSource } from "./dashboard/test-source.js";

const source = dashboardSource();
const page = functionSource("renderRunDetailHtml", source);
const commandCenter = functionSource("renderRunCommandCenterBody", source);

test("the run page title is the task; the id is secondary text", () => {
  assert.match(page.slice(0, 9000), /<h1 class="run-title">\$\{escapeHtml\(runTitle\)\}<\/h1>/u);
  assert.match(page.slice(0, 9000), /<code title="Run id">\$\{escapeHtml\(input\.run\.id\)\}<\/code>/u);
  assert.doesNotMatch(page.slice(0, 9000), /<h1>Run \$\{escapeHtml\(input\.run\.id\)\}<\/h1>/u);
});

test("the five JSON exports sit in one Export menu", () => {
  const header = page.slice(page.indexOf('<details class="export-menu">'), page.indexOf("</details>", page.indexOf('<details class="export-menu">')));
  assert.match(header, /<summary class="button secondary">Export<\/summary>/u);
  assert.equal((header.match(/role="listitem" href="\/api\//gu) ?? []).length, 5);
});

test("each run state has exactly one primary action; the rest are secondary", () => {
  const actions = commandCenter.slice(commandCenter.indexOf("const primaryActions"), commandCenter.indexOf("const approvalCards"));
  const branches = actions.split(/\n\s*:\s/u).slice(1);
  assert.ok(branches.length >= 5);
  for (const branch of branches) {
    const forms = branch.match(/(queueRunActionForm|workerActionForm|runActionForm)\([^)]*\)/gu) ?? [];
    const links = branch.match(/<a class="button"/gu) ?? [];
    const primaries = forms.filter((form) => !form.includes('"secondary"')).length + links.length;
    assert.equal(primaries, 1, branch.slice(0, 160));
  }
});
