import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceSubjectHash } from "./source-subject.js";

test("source identity is order independent and changes with content, not unrelated files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-source-"));
  try {
    await fs.writeFile(path.join(root, "a"), "one");
    await fs.writeFile(path.join(root, "b"), "two");
    const hash = await sourceSubjectHash(root, ["a", "b"]);
    assert.equal(await sourceSubjectHash(root, ["b", "a"]), hash);
    await fs.writeFile(path.join(root, "unrelated"), "preserved");
    assert.equal(await sourceSubjectHash(root, ["a", "b"]), hash);
    await fs.writeFile(path.join(root, "a"), "changed");
    assert.notEqual(await sourceSubjectHash(root, ["a", "b"]), hash);
    await fs.symlink(path.join(root, "a"), path.join(root, "link"));
    for (const scope of [[], ["../outside"], ["link"], ["missing"], ["a", "a"]]) {
      await assert.rejects(sourceSubjectHash(root, scope));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
