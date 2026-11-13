import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("actual worker reuses only a finalized command receipt with exact evidence ownership", { timeout: 60_000 }, () => {
  // Reuse the existing worker fixture; its storage/provider boundaries are
  // synthetic, while executor routing, action reuse and completion gates run.
  const fixture = fileURLToPath(new URL("./action-result-continuation.test.ts", import.meta.url));
  for (const suffix of ["finalized", "pending", "missing", "uncertain", "operation", "target", "uri", "outcome", "timedout",
    "run", "task", "content-task", "stage", "command"]) {
    const mode = `receipt-${suffix}`;
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTFLOW_CONTINUATION_TEST_CHILD: "1", AGENTFLOW_CONTINUATION_TEST_MODE: mode,
      AGENTFLOW_FALLBACK_PROVIDER: "mock" };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fixture],
      { env, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(child.error, undefined, `${mode}: child exceeded its bound`);
    assert.equal(child.status, 0, `${mode}: ${child.stdout}${child.stderr}`);
    assert.ok(child.stdout.includes(`COMMAND_RECEIPT_RECOVERY_ASSERTIONS_PASSED ${mode}`), mode);
  }
});
