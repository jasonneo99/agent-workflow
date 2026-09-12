import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodegenPlan, finishCodegenPlan, readCodegenPlan } from "./index.js";

test("governed code generation stages a hashed candidate and review diff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-codegen-"));
  await fs.writeFile(path.join(root, "reference.ts"), "export const a = 1;\n");
  const created = await createCodegenPlan({ projectRoot: root, target: "target.ts", reference: "reference.ts", referenceContent: "export const a = 1;\n", candidateContent: "export const b = 2;\n", spec: "make b", provider: "mock" });
  assert.match(created.plan.diff, /\+ export const b/u);
  const loaded = await readCodegenPlan(root, created.plan.id);
  assert.equal(loaded.candidate, "export const b = 2;\n");
  await finishCodegenPlan({ planPath: loaded.planPath, plan: loaded.plan, status: "promoted", reviewedBy: "reviewer", validation: "passed", rollback: "previous hash recorded" });
  await assert.rejects(() => readCodegenPlan(root, created.plan.id), /already terminal/u);
});
