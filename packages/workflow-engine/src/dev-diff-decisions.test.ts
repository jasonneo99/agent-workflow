import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadProjectConfig } from "../../agent-registry/src/loaders.js";
import { buildUnifiedDiff } from "../../local-tools/src/file-diff.js";
import { resolveExecutionPolicy } from "../../policy-engine/src/index.js";
import {
  createDevSession,
  listDevSessionDiffHunks,
  listDevSessionReceipts,
  syncDevSessionDiffHunks,
  upsertDevSessionDiff
} from "../../storage/src/dev-sessions.js";
import { sha256Hex } from "./direct-turn.js";
import { decideDevSessionDiff, reconstructOriginalContent } from "./dev-diff-decisions.js";

const templateProjectDir = fileURLToPath(new URL("../../../templates/project", import.meta.url));

function fortyLines(): string[] {
  return Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
}

async function setupTempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-diff-test-"));
  await fs.cp(path.join(templateProjectDir, ".agent-workflow"), path.join(dir, ".agent-workflow"), { recursive: true });
  const loaded = await loadProjectConfig(dir);
  const project = resolveExecutionPolicy(loaded, "trusted-personal").project;
  const session = await createDevSession({ projectRootUri: dir, provider: "mock", title: "Diff decisions test" });
  return { dir, project, session };
}

async function proposeChange(input: {
  sessionId: string;
  dir: string;
  relativePath: string;
  original: string;
  proposed: string;
}) {
  await fs.mkdir(path.dirname(path.join(input.dir, input.relativePath)), { recursive: true });
  await fs.writeFile(path.join(input.dir, input.relativePath), input.original, "utf8");
  const diffText = buildUnifiedDiff(input.relativePath, input.original, input.proposed);
  const diff = await upsertDevSessionDiff({
    sessionId: input.sessionId,
    turnId: null,
    path: input.relativePath,
    originalHash: sha256Hex(input.original),
    proposedContent: input.proposed,
    diffText,
    payloadHash: sha256Hex(input.proposed)
  });
  const hunks = await syncDevSessionDiffHunks(
    diff.id,
    buildUnifiedDiff(input.relativePath, input.original, input.proposed)
      .split("\n")
      .filter((line) => line.startsWith("@@ "))
  );
  return { diff, hunks };
}

test("reconstructOriginalContent inverts a modify diff and a new-file diff", () => {
  const original = "alpha\nbeta\ngamma\n";
  const proposed = "alpha\nBETA\ngamma\n";
  const diff = buildUnifiedDiff("src/a.txt", original, proposed);
  assert.equal(reconstructOriginalContent(proposed, diff), original);
  const newFile = buildUnifiedDiff("src/new.txt", "", "hello\n");
  assert.equal(reconstructOriginalContent("hello\n", newFile), "");
});

test("accepting a whole file applies every hunk and receipts the decision", async () => {
  const { dir, project, session } = await setupTempProject();
  try {
    const lines = fortyLines();
    const original = `${lines.join("\n")}\n`;
    const changed = [...lines];
    changed[1] = "CHANGED 2";
    changed[38] = "CHANGED 39";
    const proposed = `${changed.join("\n")}\n`;
    const { diff } = await proposeChange({ sessionId: session.id, dir, relativePath: "src/multi.txt", original, proposed });
    const result = await decideDevSessionDiff({
      diffId: diff.id,
      decision: "accept",
      decidedBy: "test-user",
      projectDir: dir,
      project
    });
    assert.deepEqual(result.appliedHunks, [0, 1]);
    assert.equal(result.diff.status, "accepted");
    assert.equal(await fs.readFile(path.join(dir, "src/multi.txt"), "utf8"), proposed);
    assert.equal(result.newHash, sha256Hex(proposed));
    const receipts = await listDevSessionReceipts(session.id);
    assert.ok(receipts.some((receipt) => receipt.actionType === "dev_diff_accepted"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("accepting hunks one at a time shifts later positions correctly", async () => {
  const { dir, project, session } = await setupTempProject();
  try {
    const lines = fortyLines();
    const original = `${lines.join("\n")}\n`;
    // First hunk adds two lines (delta +2); the second hunk must still land.
    const changed = [...lines];
    changed.splice(1, 1, "CHANGED 2a", "CHANGED 2b", "CHANGED 2c");
    changed[40] = "CHANGED 39";
    const proposed = `${changed.join("\n")}\n`;
    const { diff } = await proposeChange({ sessionId: session.id, dir, relativePath: "src/shift.txt", original, proposed });
    const first = await decideDevSessionDiff({
      diffId: diff.id,
      decision: "accept",
      hunkIndex: 0,
      decidedBy: "test-user",
      projectDir: dir,
      project
    });
    assert.deepEqual(first.appliedHunks, [0]);
    assert.equal(first.diff.status, "proposed");
    const afterFirst = await fs.readFile(path.join(dir, "src/shift.txt"), "utf8");
    assert.match(afterFirst, /CHANGED 2a/);
    assert.doesNotMatch(afterFirst, /CHANGED 39/);

    const second = await decideDevSessionDiff({
      diffId: diff.id,
      decision: "accept",
      hunkIndex: 1,
      decidedBy: "test-user",
      projectDir: dir,
      project
    });
    assert.deepEqual(second.appliedHunks, [1]);
    assert.equal(second.diff.status, "accepted");
    assert.equal(await fs.readFile(path.join(dir, "src/shift.txt"), "utf8"), proposed);

    await assert.rejects(
      decideDevSessionDiff({ diffId: diff.id, decision: "accept", hunkIndex: 1, decidedBy: "test-user", projectDir: dir, project }),
      /no proposed hunks left|already decided/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rejecting a hunk leaves the file untouched and keeps the parent proposed when mixed", async () => {
  const { dir, project, session } = await setupTempProject();
  try {
    const lines = fortyLines();
    const original = `${lines.join("\n")}\n`;
    const changed = [...lines];
    changed[1] = "CHANGED 2";
    changed[38] = "CHANGED 39";
    const proposed = `${changed.join("\n")}\n`;
    const { diff } = await proposeChange({ sessionId: session.id, dir, relativePath: "src/mixed.txt", original, proposed });
    await decideDevSessionDiff({ diffId: diff.id, decision: "accept", hunkIndex: 0, decidedBy: "test-user", projectDir: dir, project });
    const result = await decideDevSessionDiff({ diffId: diff.id, decision: "reject", hunkIndex: 1, decidedBy: "test-user", projectDir: dir, project });
    assert.deepEqual(result.rejectedHunks, [1]);
    assert.equal(result.diff.status, "proposed");
    const hunks = await listDevSessionDiffHunks(diff.id);
    assert.deepEqual(
      hunks.map((hunk) => hunk.status),
      ["accepted", "rejected"]
    );
    const content = await fs.readFile(path.join(dir, "src/mixed.txt"), "utf8");
    assert.match(content, /CHANGED 2/);
    assert.doesNotMatch(content, /CHANGED 39/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rejecting a whole file changes nothing and marks the diff rejected", async () => {
  const { dir, project, session } = await setupTempProject();
  try {
    const original = "keep me\n";
    const proposed = "change me\n";
    const { diff } = await proposeChange({ sessionId: session.id, dir, relativePath: "src/keep.txt", original, proposed });
    const result = await decideDevSessionDiff({ diffId: diff.id, decision: "reject", decidedBy: "test-user", projectDir: dir, project });
    assert.deepEqual(result.rejectedHunks, [0]);
    assert.equal(result.diff.status, "rejected");
    assert.equal(await fs.readFile(path.join(dir, "src/keep.txt"), "utf8"), original);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("accepting a stale proposal fails before any write", async () => {
  const { dir, project, session } = await setupTempProject();
  try {
    const original = "version one\n";
    const proposed = "version two\n";
    const { diff } = await proposeChange({ sessionId: session.id, dir, relativePath: "src/stale.txt", original, proposed });
    await fs.writeFile(path.join(dir, "src/stale.txt"), "someone else edited this\n", "utf8");
    await assert.rejects(
      decideDevSessionDiff({ diffId: diff.id, decision: "accept", decidedBy: "test-user", projectDir: dir, project }),
      /Stale preimage/
    );
    assert.equal(await fs.readFile(path.join(dir, "src/stale.txt"), "utf8"), "someone else edited this\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("accepting a proposed new file creates it", async () => {
  const { dir, project, session } = await setupTempProject();
  try {
    const relativePath = "src/created.txt";
    const proposed = "brand new\n";
    const diffText = buildUnifiedDiff(relativePath, "", proposed);
    const diff = await upsertDevSessionDiff({
      sessionId: session.id,
      turnId: null,
      path: relativePath,
      originalHash: null,
      proposedContent: proposed,
      diffText,
      payloadHash: sha256Hex(proposed)
    });
    await syncDevSessionDiffHunks(
      diff.id,
      diffText.split("\n").filter((line) => line.startsWith("@@ "))
    );
    const result = await decideDevSessionDiff({ diffId: diff.id, decision: "accept", decidedBy: "test-user", projectDir: dir, project });
    assert.deepEqual(result.appliedHunks, [0]);
    assert.equal(await fs.readFile(path.join(dir, relativePath), "utf8"), proposed);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
