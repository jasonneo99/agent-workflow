import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { indexProjectFiles } from "./index.js";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";

const execFileAsync = promisify(execFile);

const project: ProjectConfig = {
  project: {
    name: "Incremental Test",
    summary: "Project used by indexer tests.",
    autonomy: 2,
    default_workflows: ["maintain-context"]
  },
  context: {
    include: ["**/*.md"],
    exclude: [".git/**"],
    max_project_tokens: 12000
  },
  storage: {
    cache_summaries: true,
    semantic_index: true
  },
  execution: {
    policy_profile: "local",
    policy_profiles: {}
  },
  policies: {
    allow_wide_open: false,
    require_approval_for_external_actions: true,
    require_receipts: true
  },
  team: {
    default_actor_role: "operator",
    roles: {}
  },
  actions: {
    allowed_commands: [],
    blocked_commands: ["rm *", "git reset *", "git clean *", "sudo *"],
    command_timeout_ms: 120000,
    max_output_chars: 20000,
    allowed_write_paths: [],
    blocked_write_paths: [".git/**", "node_modules/**", ".env", ".env.*"],
    max_write_bytes: 200000,
    approval_rules: []
  }
};

test("incremental indexing refreshes changed files and reports deleted summaries", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-index-"));
  await execFileAsync("git", ["init"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.email", "test@example.local"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: projectDir });
  await fs.writeFile(path.join(projectDir, "a.md"), "# A\n\nInitial alpha content.\n");
  await fs.writeFile(path.join(projectDir, "b.md"), "# B\n\nInitial beta content.\n");
  await execFileAsync("git", ["add", "."], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: projectDir });

  const first = await indexProjectFiles({ projectDir, project, maxFiles: 10 });
  assert.equal(first.incremental, false);
  assert.equal(first.files.length, 2);
  assert.equal(first.deletedSourceUris.length, 0);
  assert.ok(first.headCommit);

  await fs.writeFile(path.join(projectDir, "a.md"), "# A\n\nUpdated alpha content.\n");
  await fs.rm(path.join(projectDir, "b.md"));
  await fs.writeFile(path.join(projectDir, "c.md"), "# C\n\nNew gamma content.\n");

  const second = await indexProjectFiles({
    projectDir,
    project,
    maxFiles: 10,
    existingSummaries: first.files,
    deltaOnly: true,
    sinceCommit: first.headCommit
  });

  assert.equal(second.incremental, true);
  assert.deepEqual(second.files.map((file) => file.sourceUri).sort(), ["a.md", "c.md"]);
  assert.deepEqual(second.deletedSourceUris, ["b.md"]);
  assert.equal(second.changed, 2);
  assert.equal(second.reused, 0);
  assert.equal(second.fullIndexFallback, false);
});

test("incremental indexing reuses unchanged summaries without rewriting files", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-index-"));
  await execFileAsync("git", ["init"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.email", "test@example.local"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: projectDir });
  await fs.writeFile(path.join(projectDir, "a.md"), "# A\n\nInitial alpha content.\n");
  await execFileAsync("git", ["add", "."], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: projectDir });

  const first = await indexProjectFiles({ projectDir, project, maxFiles: 10 });
  const second = await indexProjectFiles({
    projectDir,
    project,
    maxFiles: 10,
    existingSummaries: first.files,
    deltaOnly: true,
    sinceCommit: first.headCommit
  });

  assert.equal(second.incremental, true);
  assert.equal(second.files.length, 0);
  assert.equal(second.reused, 1);
  assert.equal(second.changed, 0);
  assert.deepEqual(second.deletedSourceUris, []);
});
