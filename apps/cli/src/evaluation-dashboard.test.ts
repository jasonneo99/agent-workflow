import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("evaluation dashboard bounds per-run report loading", () => {
  assert.match(
    source,
    /async function loadDashboardEvaluations[\s\S]+mapWithConcurrency\(runs, 8,[\s\S]+loadCostQualityReport/u
  );
});
