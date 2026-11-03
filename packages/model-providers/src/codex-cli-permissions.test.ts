import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCliProvider, createCodexCliRunner } from "./codex-cli.js";
import { assertCodexCliVersion, qualifiedCodexCliVersion } from "./codex-cli-permissions.js";

test("unqualified CLI versions fail closed without environment overrides", () => {
  assert.doesNotThrow(() => assertCodexCliVersion(`codex-cli ${qualifiedCodexCliVersion}\n`));
  for (const version of ["codex-cli 0.159.0", "codex-cli 0.160.1", "codex-cli 1.0.0", "", "0.160.0", "codex-cli 0.160.0\nextra"]) {
    assert.throws(() => assertCodexCliVersion(version), { code: "CODEX_CLI_UNQUALIFIED_VERSION", retryable: false });
  }
});

async function fixture(version: string, operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-permissions-"));
  const executable = path.join(directory, "fake-codex.mjs");
  await fs.writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2),root=${JSON.stringify(directory)};
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(args[0]==='--version'){console.log(${JSON.stringify(version)});process.exit(0);}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const schemaPath=args[args.indexOf('--output-schema')+1];
fs.writeFileSync(root+'/execution.json',JSON.stringify({args,cwd:process.cwd(),prompt,schema:JSON.parse(fs.readFileSync(schemaPath,'utf8'))}));
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{}');
console.log('{"type":"turn.completed"}');
`, { mode: 0o700 });
  const env: Record<string, string> = {
    CODEX_CLI_BIN: executable, AGENTFLOW_EGRESS_LOG_DIR: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    AGENTFLOW_CODEX_SESSION_REUSE: "1", AGENTFLOW_CODEX_DIRECT_REPO_INSPECTION: "1"
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    await operation(directory);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("actual spawn forwards the restricted profile, schema and model from a neutral fresh cwd", { skip: process.platform === "win32" }, async () => {
  await fixture("codex-cli 0.160.0", async directory => {
    const runner = createCodexCliRunner();
    assert.match(await runner.authStatus(), /Logged in using ChatGPT/u);
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    assert.equal((await runner.execute({ prompt: "synthetic structured action", schema, model: "synthetic-model", reasoningEffort: "low", workingDirectory: directory, sessionKey: "synthetic-same-stage" })).output, "{}");
    const execution = JSON.parse(await fs.readFile(path.join(directory, "execution.json"), "utf8"));
    const args = execution.args as string[];
    assert.equal(args[0], "exec");
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config"]) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes("--sandbox")); assert.ok(!args.includes("resume"));
    assert.notEqual(execution.cwd, directory);
    assert.equal(args[args.indexOf("--cd") + 1], execution.cwd);
    assert.equal(args[args.indexOf("--model") + 1], "synthetic-model");
    assert.deepEqual(execution.schema, schema); assert.equal(execution.prompt, "synthetic structured action");
    const configs = args.filter((_, index) => args[index - 1] === "--config");
    for (const config of [
      'approval_policy="never"', 'default_permissions="agentflow_stage_readonly"',
      "permissions.agentflow_stage_readonly.network.enabled=false", "project_doc_max_bytes=0", "agents.enabled=false",
      "features.shell_tool=false", "features.code_mode_host=false", "features.multi_agent_v2=false",
      "features.apps=false", "features.plugins=false", "features.hooks=false", 'web_search="disabled"',
      "features.view_image=false", "features.image_generation=false", 'model_reasoning_effort="low"'
    ]) assert.ok(configs.includes(config), config);
    const filesystem = configs.find(config => config.startsWith("permissions.agentflow_stage_readonly.filesystem="));
    const realBinary = await fs.realpath(path.join(directory, "fake-codex.mjs"));
    assert.equal(filesystem, `permissions.agentflow_stage_readonly.filesystem={":minimal"="read",${JSON.stringify(execution.cwd)}="read",${JSON.stringify(realBinary)}="read"}`);
    // The neutral workspace is removed after the controller consumes the output.
    await assert.rejects(fs.stat(execution.cwd), { code: "ENOENT" });
  });
});

test("the documented bare codex command resolves one owned PATH executable for version and execution", { skip: process.platform === "win32" }, async () => {
  await fixture("codex-cli 0.160.0", async directory => {
    await fs.symlink(path.join(directory, "fake-codex.mjs"), path.join(directory, "codex"));
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    const repository = path.join(directory, "untrusted-repository");
    await fs.mkdir(repository);
    await fs.writeFile(path.join(repository, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    try {
      process.env.CODEX_CLI_BIN = "codex";
      process.env.PATH = directory + path.delimiter + (previousPath ?? "");
      process.chdir(repository);
      assert.equal((await createCodexCliRunner().execute({ prompt: "owned PATH fixture", schema: {} })).output, "{}");
      const calls = (await fs.readFile(path.join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(calls.map(call => call.args[0]), ["--version", "exec"]);
      const execution = JSON.parse(await fs.readFile(path.join(directory, "execution.json"), "utf8"));
      const resolved = await fs.realpath(path.join(directory, "fake-codex.mjs"));
      assert.ok(execution.args.some((arg: string) => arg.includes(`${JSON.stringify(resolved)}="read"`)));
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  });
});

for (const version of ["codex-cli 0.159.0", "codex-cli 0.160.1", "malformed version"]) {
  test(`actual unsupported version stops before authentication or inference: ${version}`, { skip: process.platform === "win32" }, async () => {
    await fixture(version, async directory => {
      const runner = createCodexCliRunner();
      await assert.rejects(runner.authStatus(), { code: "CODEX_CLI_UNQUALIFIED_VERSION" });
      await assert.rejects(runner.execute({ prompt: "must never reach child stdin", schema: {} }), { code: "CODEX_CLI_UNQUALIFIED_VERSION" });
      const readiness = await new CodexCliProvider(runner).check();
      assert.equal(readiness.ready, false); assert.match(readiness.details[0], /requires qualified version 0\.160\.0/u);
      const calls = (await fs.readFile(path.join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(calls.map(call => call.args), [["--version"], ["--version"], ["--version"]]);
      await assert.rejects(fs.stat(path.join(directory, "execution.json")), { code: "ENOENT" });
    });
  });
}
