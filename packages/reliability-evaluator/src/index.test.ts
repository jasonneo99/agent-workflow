import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { evaluatorResponseSchema } from "./index.js";

test("hidden evaluator runs in a separate process and returns only bounded evidence", async () => {
  const runner = path.resolve(import.meta.dirname, "runner.ts");
  const child = spawn(process.execPath, ["--import", "tsx", runner], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ protocol_version: 1, case_id: "debugging-synthetic", candidate: { root_cause: "inclusive-upper-bound", regression_test: true } }));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 0, stderr);
  const response = evaluatorResponseSchema.parse(JSON.parse(stdout));
  assert.equal(response.passed, true);
  assert.equal("candidate" in response, false);
  assert.equal("expected" in response, false);
});

test("hidden evaluator rejects an incorrect candidate", async () => {
  const runner = path.resolve(import.meta.dirname, "runner.ts");
  const child = spawn(process.execPath, ["--import", "tsx", runner], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ protocol_version: 1, case_id: "release-readiness-synthetic", candidate: { decision: "go" } }));
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 0);
  assert.equal(evaluatorResponseSchema.parse(JSON.parse(stdout)).passed, false);
});
