import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRoadmapSnapshot, parseRoadmapSnapshot, readRoadmapSnapshotFromProject, serverRoadmapSnapshot } from "./index.js";

const base = { projectId: "project-1", projectName: "Example", source: "docs/roadmap.md", publishingHost: "loki" };

test("publishes bounded roadmap metadata without host paths", () => {
  const snapshot = buildRoadmapSnapshot({ ...base, markdown: "# One\n- [ ] Open /Users/person/private item\n- [x] Done item", sourceModifiedAt: "2026-09-10T00:00:00.000Z", publishedAt: "2026-09-10T01:00:00.000Z" });
  assert.equal(snapshot.openItems, 1);
  assert.equal(snapshot.totalItems, 2);
  assert.equal(snapshot.items[1].status, "done");
  assert.equal(JSON.stringify(snapshot).includes("/Users/"), false);
});

test("classifies current, stale, missing, and invalid snapshots explicitly", () => {
  const snapshot = buildRoadmapSnapshot({ ...base, markdown: "- [ ] Work", publishedAt: "2026-09-08T00:00:00.000Z" });
  assert.equal(serverRoadmapSnapshot(snapshot, Date.parse("2026-09-08T00:00:01.000Z")).freshness, "current");
  assert.equal(serverRoadmapSnapshot(snapshot, Date.parse("2026-09-10T00:00:01.000Z")).freshness, "stale");
  assert.equal(serverRoadmapSnapshot({ ...snapshot, status: "missing" }).freshness, "missing");
  assert.equal(parseRoadmapSnapshot({ ...snapshot, publishedAt: "bad" }, "project-1"), null);
});

test("rejects path escape and symlink escape and bounds oversized input", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-roadmap-snapshot-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-roadmap-outside-"));
  await fs.writeFile(path.join(outsideDir, "roadmap.md"), "- [ ] private", "utf8");
  await fs.symlink(path.join(outsideDir, "roadmap.md"), path.join(projectDir, "ROADMAP.md"));
  await assert.rejects(() => readRoadmapSnapshotFromProject({ ...base, projectRootUri: projectDir, source: "../roadmap.md" }), /must remain inside the project/u);
  await assert.rejects(() => readRoadmapSnapshotFromProject({ ...base, projectRootUri: projectDir, source: "ROADMAP.md" }), /symbolic links must remain inside/u);
  await fs.writeFile(path.join(projectDir, "large.md"), "x".repeat(33), "utf8");
  const oversized = await readRoadmapSnapshotFromProject({ ...base, projectRootUri: projectDir, source: "large.md", maxBytes: 32 });
  assert.equal(oversized.reason, "source exceeds size limit");
});

test("rejects malformed payloads and an unavailable publishing host", () => {
  const snapshot = buildRoadmapSnapshot({ ...base, markdown: "- [ ] Work" });
  assert.equal(parseRoadmapSnapshot({ ...snapshot, publishingHost: "" }, "project-1"), null);
  assert.equal(parseRoadmapSnapshot({ ...snapshot, items: "not-an-array" }, "project-1"), null);
  assert.equal(parseRoadmapSnapshot(snapshot, "different-project"), null);
});

test("project identity, not duplicate project name, selects a snapshot", () => {
  const one = buildRoadmapSnapshot({ ...base, markdown: "- [ ] One" });
  const two = buildRoadmapSnapshot({ ...base, projectId: "project-2", markdown: "- [ ] Two" });
  assert.equal([one, two].find((snapshot) => snapshot.projectId === "project-2")?.items[0].title, "Two");
});
