import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();

test("Discovery filters and pages its candidate list", () => {
  assert.match(source, /const candidatePage = pageOf\(matchingCandidates, params, 25\);/u);
  assert.match(source, /<form class="list-filter" method="get" action="\/discovery#candidate-projects" role="search">/u);
  assert.match(source, /const rows = candidatePage\.items\.map\(/u);
});

test("Activity pages its timeline 50 events at a time", () => {
  assert.match(source, /const eventPage = pageOf\(report\.events, params, 50\);/u);
  assert.match(source, /pagerHtml\("\/activity", params, eventPage, "Timeline"\)/u);
});

test("Agents filters the roster and collapses the shared bundle list", () => {
  assert.match(source, /data-filter-rows="effective-roster"/u);
  assert.match(source, /<details class="panel collapsible-panel">\s*<summary><h2>Shared Bundle Agents/u);
});

test("Model improvement gets an on-page index with collapsible sections", () => {
  assert.match(source, /\$\{report \? dashboardSectionIndex\(\) : ""\}/u);
  const index = source.slice(source.indexOf("function dashboardSectionIndex"));
  assert.match(index.slice(0, 3000), /DOMContentLoaded/u);
  assert.match(index.slice(0, 3000), /setOpen\(section,index<2\)/u);
  assert.match(index.slice(0, 3000), /aria-expanded/u);
});
