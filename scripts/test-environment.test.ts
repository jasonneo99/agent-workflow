import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("test bootstrap resolves project database after worker sanitization without importing other secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evaluation-test-env-"));
  const bootstrap = fileURLToPath(new URL("./test-environment.mjs", import.meta.url));
  try {
    await mkdir(path.join(root, ".agent-workflow"));
    await writeFile(path.join(root, ".env"), "DATABASE_URL=postgres://synthetic/base\nUNRELATED_TEST_SECRET=do-not-import\n");
    await writeFile(path.join(root, ".agent-workflow/runtime.env"), "DATABASE_URL=postgres://synthetic/runtime\n");
    for (const [extra, expected] of [
      [{}, "postgres://synthetic/runtime"],
      [{ DATABASE_URL: "postgres://synthetic/explicit" }, "postgres://synthetic/explicit"],
      [{ TEST_DATABASE_URL: "postgres://synthetic/disposable" }, "postgres://synthetic/disposable"],
    ] as const) {
      const env = { ...process.env };
      delete env.DATABASE_URL; delete env.TEST_DATABASE_URL; delete env.UNRELATED_TEST_SECRET;
      Object.assign(env, extra);
      const result = spawnSync(process.execPath, ["--import", bootstrap, "-e", "console.log(JSON.stringify({database:process.env.DATABASE_URL,other:process.env.UNRELATED_TEST_SECRET}))"], { cwd: root, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { database: expected });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
