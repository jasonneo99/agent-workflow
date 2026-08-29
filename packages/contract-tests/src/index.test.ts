import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MockProvider } from "../../model-providers/src/mock.js";
import { runDefinitionContractTests } from "./index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("contract tests pass built-in definitions with mock provider", async () => {
  const report = await runDefinitionContractTests({
    definitionsDir: rootDir,
    provider: new MockProvider(),
    liveProvider: false
  });
  assert.equal(report.passed, true);
  assert.ok(report.results.some((result) => result.id === "provider.mock.execute" && result.status === "pass"));
});

test("contract tests skip non-mock provider execution unless live is enabled", async () => {
  const report = await runDefinitionContractTests({
    definitionsDir: rootDir,
    provider: {
      id: "custom",
      async executeStage() {
        throw new Error("should not execute");
      }
    },
    liveProvider: false
  });
  assert.equal(report.passed, true);
  assert.ok(report.results.some((result) => result.id === "provider.custom.execute" && result.status === "skip"));
});
