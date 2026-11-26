import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadAgents, loadWorkflows } from "../../../packages/agent-registry/src/loaders.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("AGENTS.md lists every shared agent and workflow definition", async () => {
  const roster = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  const missing = [
    ...(await loadAgents(root)).map((agent) => agent.id),
    ...(await loadWorkflows(root)).map((workflow) => workflow.id)
  ].filter((id) => !roster.includes(`- \`${id}\`:`));
  assert.deepEqual(missing, [], "add these ids to the AGENTS.md roster");
});
