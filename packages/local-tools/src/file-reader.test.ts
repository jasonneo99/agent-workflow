import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertFileReadAllowed, executeAllowedFileRead } from "./file-reader.js";

function makeProject(overrides: Record<string, unknown> = {}): ProjectConfig {
  return {
    actions: {
      allowed_read_paths: ["src/**", "docs/**"],
      blocked_read_paths: [".env", "**/*.pem"],
      max_read_bytes: 1024,
      allowed_write_paths: [],
      blocked_write_paths: [],
      max_write_bytes: 1024,
      allowed_commands: [],
      blocked_commands: [],
      command_timeout_ms: 1000,
      max_output_chars: 100,
      auto_approve_max_risk: "none",
      approval_rules: [],
      ...overrides
    }
  } as unknown as ProjectConfig;
}

function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "file-reader-test-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("read policy allows listed paths and rejects others", () => {
  const project = makeProject();
  assert.doesNotThrow(() => assertFileReadAllowed("src/app.ts", project));
  assert.throws(() => assertFileReadAllowed("scripts/deploy.sh", project), /not allowed by project policy/);
});

test("read policy blocks secrets even under allowed roots", () => {
  const project = makeProject({ allowed_read_paths: ["**"] });
  assert.throws(() => assertFileReadAllowed(".env", project), /blocked path pattern/);
  assert.throws(() => assertFileReadAllowed("keys/deploy.pem", project), /blocked path pattern/);
});

test("read policy rejects absolute paths and parent traversal", () => {
  const project = makeProject();
  assert.throws(() => assertFileReadAllowed("/etc/passwd", project), /absolute paths/);
  assert.throws(() => assertFileReadAllowed("../outside.txt", project), /parent path segments/);
  assert.throws(() => assertFileReadAllowed("src/../../outside.txt", project), /parent path segments/);
});

test("executeAllowedFileRead returns content with hash", async () => {
  const dir = makeTree({ "src/app.ts": "export const x = 1;\n" });
  const result = await executeAllowedFileRead({ relativePath: "src/app.ts", cwd: dir, project: makeProject() });
  assert.equal(result.relativePath, "src/app.ts");
  assert.equal(result.content, "export const x = 1;\n");
  assert.equal(result.truncated, false);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("executeAllowedFileRead truncates at max_read_bytes", async () => {
  const dir = makeTree({ "src/big.ts": "x".repeat(2000) });
  const result = await executeAllowedFileRead({ relativePath: "src/big.ts", cwd: dir, project: makeProject() });
  assert.equal(result.truncated, true);
  assert.equal(result.bytesRead, 1024);
  assert.equal(result.content.length, 1024);
});

test("executeAllowedFileRead fails cleanly for missing and binary files", async () => {
  const dir = makeTree({ "src/app.ts": "ok" });
  const project = makeProject();
  await assert.rejects(
    executeAllowedFileRead({ relativePath: "src/missing.ts", cwd: dir, project }),
    /no such file/
  );
  const binDir = makeTree({ "src/blob.bin": "a\0b" });
  await assert.rejects(
    executeAllowedFileRead({ relativePath: "src/blob.bin", cwd: binDir, project }),
    /binary file/
  );
});
