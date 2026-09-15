import assert from "node:assert/strict";
import test from "node:test";
import { renderStudioHtml } from "./studio.js";

const workflows = [
  { id: "build-feature", name: "Build Feature", triggers: { manual: true } },
  { id: "automatic-only", name: "Automatic Only", triggers: { manual: false } }
];

test("studio renders the task-first governed workflow surface", () => {
  const html = renderStudioHtml({ workflows, defaultProject: "templates/project" });

  assert.match(html, /Agent Workflow Studio/);
  assert.match(html, /id="stage-strip"/);
  assert.match(html, /Changes/);
  assert.match(html, /Tests/);
  assert.match(html, /Artifacts/);
  assert.match(html, /Receipts/);
  assert.match(html, /action="\/api\/studio-task"/);
  assert.match(html, /action="\/api\/follow-up"/);
  assert.match(html, /name="returnTo"/);
  assert.match(html, /id="approval-banner"/);
  assert.match(html, /params\.get\("run"\) \|\| params\.get\("actionRun"\)/);
  assert.match(html, /id="command-return" value="\/studio"/);
  assert.match(html, /id="accept-return" value="\/studio"/);
  assert.match(html, /value="auto" selected/);
  assert.match(html, /Auto-route from my request/);
  assert.match(html, /\/api\/studio-route\?project=/);
  assert.match(html, /id="routing-preview"/);
  assert.match(html, /id="plan-editor"/);
  assert.match(html, /name="planStages"/);
  assert.match(html, /data-run-action="resume-checkpoint"/);
  assert.match(html, /data-run-action="replay-run"/);
  assert.match(html, /data-tab="files"/);
  assert.match(html, /data-tab="terminal"/);
  assert.match(html, /\/api\/studio-workspace\?project=/);
  assert.match(html, /new EventSource\("\/api\/studio-events"\)/);
  assert.match(html, /action="\/api\/approval-action"/);
  assert.match(html, /id="project-switcher"/);
  assert.doesNotMatch(html, /Automatic Only/);
});

test("studio escapes configured project paths", () => {
  const html = renderStudioHtml({ workflows, defaultProject: 'projects/<private>&"demo"' });

  assert.match(html, /projects\/&lt;private&gt;&amp;&quot;demo&quot;/);
  assert.doesNotMatch(html, /projects\/<private>/);
});
