import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("learning approvals resolve the local project before rendering action forms", () => {
  const source = readFileSync(new URL("./commands/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("function renderLearningReportHtml(");
  const renderer = source.slice(start);
  const declaration = renderer.indexOf("const localProjectDir =");
  const approvalRows = renderer.indexOf("const learningRows =");

  assert.notEqual(declaration, -1);
  assert.notEqual(approvalRows, -1);
  assert.ok(declaration < approvalRows, "localProjectDir must be initialized before approval row callbacks execute");
});
