import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, commandSerializationResource, withDeveloperToolPath, createBoundedOutputCapture, executeAllowedCommand } from "./command-executor.js";

test("bounded streaming capture preserves head and newest tail across many chunks", () => {
  const capture = createBoundedOutputCapture(200);
  capture.append("BUILD START\n");
  for (let i = 0; i < 1000; i++) capture.append("passed test\n");
  capture.append("FINAL FAILURE: regression\n");
  assert.equal(capture.text().length, 200);
  assert.ok(capture.text().startsWith("BUILD START\n"));
  assert.ok(capture.text().endsWith("FINAL FAILURE: regression\n"));
  assert.equal(capture.text().split("[middle truncated]").length, 2);
  const exact = createBoundedOutputCapture(3);
  exact.append("abc");
  assert.equal(exact.text(), "abc");
  exact.append("d");
  assert.equal(exact.text().length, 3);
});

test("executed failing command retains final stdout and stderr summaries within caps", async () => {
  const script = 'process.stdout.write("START\\n"+"x".repeat(100000)); process.stderr.write("ERROR START\\n"+"y".repeat(100000)); setTimeout(()=>{process.stdout.write("\\nFINAL TEST FAILURE\\n");process.stderr.write("\\nFINAL STACK TRACE\\n");process.exitCode=1},25)';
  const result = await executeAllowedCommand({
    commandLine: `${process.execPath} -e '${script}'`, cwd: process.cwd(),
    project: { ...project, actions: { ...project.actions, allowed_commands: [`${process.execPath} *`] } }
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.ok(result.stdout.startsWith("START\n"));
  assert.ok(result.stdout.endsWith("FINAL TEST FAILURE\n"));
  assert.ok(result.stderr.endsWith("FINAL STACK TRACE\n"));
  assert.ok(result.stdout.length <= 2000 && result.stderr.length <= 2000);
});

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

test("quoted program arguments are literal while shell operators remain rejected", () => {
  assert.doesNotThrow(() => assertCommandAllowed("npm exec -- node -e 'const x = { value: 1 }; console.log(x.value)'", project));
  for (const command of ["npm test; npm run other", "npm test | other", "npm test > output", "npm exec -- node -e 'unterminated"]) {
    assert.throws(() => assertCommandAllowed(command, project), /shell metacharacters/);
  }
  assert.throws(() => assertCommandAllowed("unknown 'literal;argument'", project), /not allowed by project policy/);
});

test("worker command environment prepends common developer tool paths", () => {
  const path = withDeveloperToolPath("/custom/bin:/usr/bin");
  assert.equal(path.split(":").slice(0, 3).join(":"), "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin");
  assert.match(path, /\/custom\/bin/);
  assert.equal(path.split(":").filter((entry) => entry === "/usr/bin").length, 1);
});

test("build commands share a project-target serialization resource", () => {
  assert.equal(
    commandSerializationResource("npm --prefix web run build", "/project"),
    commandSerializationResource("npm run build", "/project/web")
  );
  assert.equal(commandSerializationResource("npm test", "/project/web"), null);
});
