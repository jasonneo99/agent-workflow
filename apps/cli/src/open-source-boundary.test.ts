import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The release boundary is intentionally plain ESM so it can run before TypeScript is built.
// @ts-expect-error JavaScript release helper has no declaration file.
import { packagePathViolations, packageProvenanceViolations, scanBoundaryFile } from "../../../scripts/open-source-boundary-rules.mjs";

test("package provenance rejects ignored files while allowing tracked sources and generated dist", () => {
  assert.deepEqual(packageProvenanceViolations(
    ["README.md", "dist/apps/cli/src/index.js"],
    new Set(["README.md"])
  ), []);
  assert.deepEqual(packageProvenanceViolations(
    ["templates/project/.agent-workflow/learning/private.json"],
    new Set()
  ), [
    "templates/project/.agent-workflow/learning/private.json: package entry is neither tracked source nor generated dist output",
    "templates/project/.agent-workflow/learning/private.json: template runtime state is not publishable"
  ]);
  assert.deepEqual(packageProvenanceViolations(["docs/private-notes.txt"], new Set()), [
    "docs/private-notes.txt: package entry is neither tracked source nor generated dist output"
  ]);
});

test("package paths reject private template roots and generated evaluation results", () => {
  assert.deepEqual(packagePathViolations("templates/project-private-product/.agent-workflow/project.yaml"), [
    "private or undeclared template root (project-private-product)"
  ]);
  assert.deepEqual(packagePathViolations("templates/project/.agent-workflow/evaluations/result.json"), [
    "template evaluation result is not publishable"
  ]);
  assert.deepEqual(packagePathViolations("templates/project/.agent-workflow/evaluations/suite.yaml"), []);
});

test("boundary scanner rejects unexpected binaries and machine-specific text", () => {
  // boundary-synthetic-fixtures
  assert.match(scanBoundaryFile("backup.dump", Buffer.from([0, 1, 2]))[0], /unreviewed binary file/u);
  assert.deepEqual(scanBoundaryFile("docs/image.png", Buffer.from([0, 1, 2])), []);
  assert.deepEqual(scanBoundaryFile("plugins/agent-workflow/runtime-bundle.tgz", Buffer.from([0, 1, 2])), []);
  assert.match(scanBoundaryFile("docs/private.png", Buffer.from([0, ...Buffer.from("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ")]))[0], /OpenAI-style credential/u);
  const machinePathFixture = ["", "Users", "private-owner", "project"].join("/");
  assert.match(scanBoundaryFile("example.txt", Buffer.from(machinePathFixture))[0], /machine-specific user path/u);
});

test("release and publish gates enforce the open-source boundary", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.equal(packageJson.files.includes("templates/"), false);
  assert.equal(packageJson.files.some((file) => /project-(?:private-product|customer-product|commerce-site|media-product)/u.test(file)), false);
  assert.match(fs.readFileSync(new URL("../../../scripts/release-check.mjs", import.meta.url), "utf8"), /Validate open-source boundary/u);
  assert.match(fs.readFileSync(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8"), /npm run validate-boundary/u);
  assert.equal(typeof (JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts.prepublishOnly, "string");
});
