import assert from "node:assert/strict";
import test from "node:test";
import { matchesQuery, pageOf, pagerHtml } from "./paging.js";

const items = Array.from({ length: 60 }, (_, index) => index + 1);

test("pages clamp to the available range", () => {
  assert.deepEqual(pageOf(items, new URLSearchParams(), 25).items.slice(0, 2), [1, 2]);
  assert.deepEqual(pageOf(items, new URLSearchParams("page=3"), 25).items, items.slice(50));
  assert.equal(pageOf(items, new URLSearchParams("page=99"), 25).page, 3);
  assert.equal(pageOf(items, new URLSearchParams("page=x"), 25).page, 1);
});

test("the pager keeps other parameters and hides when one page is enough", () => {
  const params = new URLSearchParams("q=api&page=2");
  const html = pagerHtml("/discovery", params, pageOf(items, params, 25), "Candidates");
  assert.match(html, /Showing 26–50 of 60/u);
  assert.match(html, /href="\/discovery\?q=api" rel|rel="prev" href="\/discovery\?q=api"/u);
  assert.match(html, /rel="next" href="\/discovery\?q=api&amp;page=3"/u);
  assert.equal(pagerHtml("/x", new URLSearchParams(), pageOf(items.slice(0, 5), new URLSearchParams(), 25), "X"), "");
});

test("queries match any field, case-insensitively", () => {
  assert.equal(matchesQuery("API", "billing-api", null), true);
  assert.equal(matchesQuery("web", "billing-api", "/p/billing"), false);
  assert.equal(matchesQuery("  ", "anything"), true);
});
