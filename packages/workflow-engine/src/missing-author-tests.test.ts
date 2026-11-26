import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { missingAuthorTestCommands } from "./missing-author-tests.js";

test("only commands naming a not-yet-created project-local JS/TS test file are held back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "author-tests-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "present.test.ts"), "");
    const commands = [
      "node --test src/present.test.ts",
      "node --test \"src/new-case.test.ts\"",
      "pytest tests/test_new_case.py",
      "node --test ../outside.test.ts",
      "npm run build",
    ];
    assert.deepEqual([...await missingAuthorTestCommands(commands, root)], [
      "node --test \"src/new-case.test.ts\"",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
