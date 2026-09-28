import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTrainingProjectChoices } from "./training-projects.js";

test("training proposals prefer an available mutable project over a stale release registration", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-training-project-"));
  const projects = [
    { name: "agent-workflow", rootUri: "/home/example/releases/agent-workflow/deadbeef" },
    { name: "agent-workflow", rootUri: project }
  ];
  const result = await resolveTrainingProjectChoices(projects, projects[0].rootUri, project);
  assert.equal(result.selected, project);
  assert.deepEqual(result.projects, [{ name: "agent-workflow", rootUri: project }]);
});
