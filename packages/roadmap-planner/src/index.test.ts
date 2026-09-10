import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRoadmapSuggestionReport, formatRoadmapSuggestionReport, resolveContainedProjectPath } from "./index.js";

test("suggests unchecked roadmap tasks in document order with section context", () => {
  const report = buildRoadmapSuggestionReport({
    projectRootUri: "/tmp/example",
    roadmapPath: "docs/roadmap.md",
    markdown: "# Roadmap\n\n## Now\n- [x] shipped\n- [ ] Add retries\n\n## Later\n* [ ] Add metrics\n",
    generatedAt: "2026-09-09T00:00:00.000Z"
  });
  assert.equal(report.status, "ready");
  assert.equal(report.openItems, 2);
  assert.deepEqual(report.suggestions.map(({ title, section, line }) => ({ title, section, line })), [
    { title: "Add retries", section: "Now", line: 5 },
    { title: "Add metrics", section: "Later", line: 8 }
  ]);
  assert.match(formatRoadmapSuggestionReport(report), /does not execute roadmap items/u);
});

test("distinguishes blank and missing roadmaps", () => {
  assert.equal(buildRoadmapSuggestionReport({ projectRootUri: "/tmp/example", roadmapPath: "ROADMAP.md", markdown: "# Roadmap\n" }).status, "empty");
  assert.equal(buildRoadmapSuggestionReport({ projectRootUri: "/tmp/example", roadmapPath: "ROADMAP.md" }).status, "missing");
});

test("rejects roadmap symlinks that leave the project", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-roadmap-project-"));
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-roadmap-external-"));
  await fs.writeFile(path.join(externalDir, "roadmap.md"), "- [ ] private work\n", "utf8");
  await fs.symlink(path.join(externalDir, "roadmap.md"), path.join(projectDir, "ROADMAP.md"));
  await assert.rejects(
    resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: "ROADMAP.md", label: "roadmap_path" }),
    /symbolic links must remain inside the project/u
  );
  await fs.symlink(path.join(externalDir, "missing.md"), path.join(projectDir, "FUTURE.md"));
  await assert.rejects(
    resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: "FUTURE.md", label: "roadmap_path" }),
    /dangling symbolic link/u
  );
  await fs.symlink(externalDir, path.join(projectDir, "plans"));
  await assert.rejects(
    resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: "plans/roadmap.md", label: "roadmap_path" }),
    /symbolic links must remain inside the project/u
  );
});

test("allows ordinary missing paths and symlinks that stay inside the project", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-roadmap-contained-"));
  await fs.mkdir(path.join(projectDir, "docs"));
  await fs.writeFile(path.join(projectDir, "docs", "roadmap.md"), "# Roadmap\n", "utf8");
  await fs.symlink(path.join(projectDir, "docs", "roadmap.md"), path.join(projectDir, "ROADMAP.md"));
  const canonicalProjectDir = await fs.realpath(projectDir);
  assert.equal(await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: "ROADMAP.md" }), path.join(canonicalProjectDir, "docs", "roadmap.md"));
  assert.equal(await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: "plans/future.md" }), path.join(canonicalProjectDir, "plans", "future.md"));
});
