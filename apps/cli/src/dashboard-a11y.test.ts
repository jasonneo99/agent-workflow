import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardCss } from "./dashboard/styles.js";

const source = await readFile(new URL("./commands/daemon.ts", import.meta.url), "utf8");

test("every dashboard page offers a skip link to its main content", () => {
  assert.match(source, /<a class="skip-link" href="#main-content">Skip to content<\/a>/u);
  assert.doesNotMatch(source, /<main>/u, "every main landmark carries the skip-link target");
  assert.match(dashboardCss(), /\.skip-link:focus \{ top: 12px; \}/u);
  assert.match(dashboardCss(), /html:not\(\[data-theme="dark"\]\) a\.skip-link, html:not\(\[data-theme="dark"\]\) a\.skip-link:hover \{ color: #fff; \}/u, "the light theme's link colour must not hide the skip link");
});

test("approval decisions share one labelled note and the pressed button carries the decision", () => {
  const forms = source.slice(source.indexOf("function approvalDecisionForms("), source.indexOf("function approvalDismissForm("));
  assert.equal(forms.match(/name="note"/gu)?.length, 1);
  assert.match(forms, /aria-label="Decision note"/u);
  assert.doesNotMatch(forms, /type="hidden" name="decision"/u);
  for (const decision of ["approved", "rejected"]) assert.match(forms, new RegExp(`name="decision" value="${decision}"`, "u"));
});

test("run feedback notes are labelled", () => {
  const feedback = source.slice(source.indexOf("function feedbackForm("), source.indexOf("function feedbackRatingForBucket("));
  assert.match(feedback, /<input name="note" aria-label="\$\{escapeHtml\(label\)\} note"/u);
});
