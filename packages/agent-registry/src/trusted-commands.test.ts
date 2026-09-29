import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadProjectConfig } from "./loaders.js";
import {
  addGlobalTrustedCommand,
  globalTrustedCommandsPath,
  loadGlobalTrustedCommands,
  normalizeTrustedCommandPattern,
  removeGlobalTrustedCommand
} from "./trusted-commands.js";

test("global trusted commands are normalized, deduplicated, persisted, and removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-trusted-commands-"));
  const filePath = path.join(root, "trusted-commands.yaml");
  assert.equal(globalTrustedCommandsPath({ filePath }), filePath);
  assert.equal((await addGlobalTrustedCommand("  gh   *  ", { filePath })).created, true);
  assert.equal((await addGlobalTrustedCommand("gh *", { filePath })).created, false);
  assert.deepEqual(await loadGlobalTrustedCommands({ filePath }), ["gh *"]);
  assert.equal((await removeGlobalTrustedCommand("gh *", { filePath })).removed, true);
  assert.deepEqual(await loadGlobalTrustedCommands({ filePath }), []);
});

test("trusted command patterns reject multiline input", () => {
  assert.throws(() => normalizeTrustedCommandPattern("npm *\nrm -rf ."), /single line/);
});

test("project config merges global trusted commands without duplicates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-project-commands-"));
  const configDir = path.join(root, ".agent-workflow");
  const globalFile = path.join(root, "global.yaml");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "project.yaml"), YAML.stringify({
    project: { name: "test", summary: "", roadmap_path: "ROADMAP.md", default_workflows: [], autonomy: 2 },
    actions: { allowed_commands: ["npm *"] }
  }));
  await fs.writeFile(globalFile, YAML.stringify({ commands: ["npm *", "gh *"] }));
  const project = await loadProjectConfig(root, { filePath: globalFile });
  assert.deepEqual(project.actions.allowed_commands, ["npm *", "gh *"]);
});
