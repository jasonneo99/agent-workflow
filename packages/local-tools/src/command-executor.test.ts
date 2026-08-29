import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed } from "./command-executor.js";

const project = {
  actions: {
    allowed_commands: ["npm *", "python3 *"],
    blocked_commands: [],
    allowed_write_paths: [],
    max_file_write_bytes: 1024,
    command_timeout_ms: 120000,
    max_output_chars: 2000,
    approval_rules: []
  }
} as unknown as ProjectConfig;

test("worker command policy rejects long-running server commands", () => {
  assert.throws(
    () => assertCommandAllowed("python3 -m http.server 8080", project),
    /long-running server commands/
  );
  assert.throws(
    () => assertCommandAllowed("npm run dev", project),
    /long-running server commands/
  );
});

test("worker command policy allows finite commands from allowlist", () => {
  assert.doesNotThrow(() => assertCommandAllowed("npm test", project));
  assert.doesNotThrow(() => assertCommandAllowed("python3 scripts/check.py", project));
});
