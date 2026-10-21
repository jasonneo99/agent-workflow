import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTemplateManifestEntries } from "./template-manifest.js";

test("template manifest returns only declared portable files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-template-manifest-"));
  await fs.writeFile(path.join(root, "template-manifest.json"), JSON.stringify({ project: ["AGENTS.md", ".agent-workflow/project.yaml", "AGENTS.md"] }));
  assert.deepEqual(await loadTemplateManifestEntries(root, "project"), [".agent-workflow/project.yaml", "AGENTS.md"]);
});

test("template manifest rejects traversal and missing profiles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-template-manifest-"));
  await fs.writeFile(path.join(root, "template-manifest.json"), JSON.stringify({ project: ["../private.txt"] }));
  await assert.rejects(loadTemplateManifestEntries(root, "project"), /escapes project/u);
  await assert.rejects(loadTemplateManifestEntries(root, "simple"), /no valid entry list/u);
});

test("template manifest rejects normalized and platform-alternate traversal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-template-manifest-"));
  for (const entry of ["inside/../../outside.txt", "inside/../outside.txt", "inside\\..\\outside.txt", "/outside.txt"]) {
    await fs.writeFile(path.join(root, "template-manifest.json"), JSON.stringify({ project: [entry] }));
    await assert.rejects(loadTemplateManifestEntries(root, "project"), /escapes project/u);
  }
});
