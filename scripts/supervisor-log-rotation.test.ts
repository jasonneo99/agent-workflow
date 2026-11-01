import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rotateFileIfOversized, rotateSupervisorLogs } from "./supervisor-log-rotation.mjs";

test("copy-truncate rotation preserves the active path and bounded history", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-log-rotation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "stdout.log");

  await fs.writeFile(file, "first oversized record");
  const first = await rotateFileIfOversized(file, { maxBytes: 16, keep: 2 });
  assert.equal(first.rotated, true);
  assert.equal(await fs.readFile(file, "utf8"), "");
  assert.equal(await fs.readFile(`${file}.1`, "utf8"), "oversized record");

  await fs.writeFile(file, "second oversized record");
  await rotateFileIfOversized(file, { maxBytes: 16, keep: 2 });
  assert.equal(await fs.readFile(`${file}.1`, "utf8"), "oversized record");
  assert.equal(await fs.readFile(`${file}.2`, "utf8"), "oversized record");
});

test("supervisor rotation ignores absent and small logs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-log-rotation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "stdout.log"), "ok");

  const results = await rotateSupervisorLogs(directory, { maxBytes: 10, keep: 2 });
  assert.deepEqual(results.map((result) => result.rotated), [false, false]);
});
