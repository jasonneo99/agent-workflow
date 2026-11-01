import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expandCompileArguments, probeCommandExecutionCapabilities, pythonCompilationCacheDirectory } from "./command-executor.js";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertCommandAllowed, commandSerializationResource, withDeveloperToolPath, createBoundedOutputCapture, executeAllowedCommand } from "./command-executor.js";
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';

test('required prepared execution has no host fallback and cannot delegate Git publication to the model',async()=>{
 const project=projectConfigSchema.parse({project:{name:'Required source'},actions:{allowed_commands:['node --version','git *']}});
 await assert.rejects(executeAllowedCommand({cwd:process.cwd(),project,commandLine:'node --version',environmentContext:{runId:'missing-profile',requireEnvironment:true,managedSource:true}}),/declared prepared environment/i);
 for(const commandLine of ['git commit -m bypass','git reset --hard','git add .'])await assert.rejects(executeAllowedCommand({cwd:process.cwd(),project,commandLine,environmentContext:{runId:'source',requireEnvironment:true,managedSource:true}}),/owned by the prepared runtime|blocked pattern/);
 const status=await executeAllowedCommand({cwd:process.cwd(),project,commandLine:'git status --porcelain',environmentContext:{runId:'source',requireEnvironment:true,managedSource:true}});
 assert.equal(status.exitCode,0);
 await assert.rejects(executeAllowedCommand({cwd:process.cwd(),project,commandLine:'git diff --no-index /etc/passwd /etc/hosts',environmentContext:{runId:'source',requireEnvironment:true}}),/cannot escape/);
});

test('environment management is a runner capability even when no test selector matched the agent command',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-runner-capability-')));
 const project=projectConfigSchema.parse({project:{name:'Runner capability'},actions:{allowed_commands:['npm run agentflow -- environments *','npm run agentflow -- repair-checkpoint *'],blocked_commands:[]}});
 try{
  for(const commandLine of ['npm run agentflow -- environments list','npm run agentflow -- environments --project synthetic --run synthetic','npm run agentflow -- repair-checkpoint --execute']){
   for(const environmentContext of [undefined,{runId:'synthetic-review'}]){
    await assert.rejects(executeAllowedCommand({cwd:root,project,commandLine,environmentContext}),/request the underlying authorized test command/u);
   }
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('real declared unittest execution distinguishes all-skipped exit zero from passing tests',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-recipe-evidence-')));
 try{
  await fs.mkdir(path.join(root,'tests'));
  const file=path.join(root,'tests/test_synthetic.py'),commandLine='python3 -m unittest discover -s tests -p test_synthetic.py -v';
  const project=projectConfigSchema.parse({project:{name:'Synthetic recipe output'},actions:{allowed_commands:[commandLine],blocked_commands:[],verification_recipes:[{source_paths:['tests/test_synthetic.py'],test_paths:['tests/test_synthetic.py'],commands:[commandLine],output_paths:[]}]}});
  await fs.writeFile(file,["import unittest","@unittest.skip('synthetic missing dependency')","class Check(unittest.TestCase):"," def test_case(self): self.assertTrue(True)",""].join('\n'));
  const skipped=await executeAllowedCommand({cwd:root,project,commandLine});assert.equal(skipped.exitCode,0);assert.equal(skipped.verificationRecipe?.status,'failed');assert.equal(skipped.verificationRecipe?.skipped,1);
  await fs.writeFile(file,"import unittest\nclass Check(unittest.TestCase):\n def test_case(self): self.assertTrue(True)\n");
  const passed=await executeAllowedCommand({cwd:root,project,commandLine});assert.equal(passed.exitCode,0);assert.equal(passed.verificationRecipe?.status,'passed');assert.equal(passed.verificationRecipe?.passed,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

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

test("approved compilation expands bounded paths without a shell", async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "compile-glob-")));
  try {
    await fs.mkdir(path.join(cwd,"source"));
    await fs.writeFile(path.join(cwd,"source","two words.py"),"value = 1\n");
    await fs.writeFile(path.join(cwd,"source","-leading.py"),"value = 2\n");
    const commandLine = "python3 -m py_compile source/*.py";
    const result = await executeAllowedCommand({commandLine,cwd,project});
    assert.equal(result.exitCode,0,result.stderr);
    assert.equal(result.commandLine,commandLine);
    const compiled=await fs.readdir(pythonCompilationCacheDirectory("source/two words.py",cwd));
    assert.ok(compiled.some(name=>name.startsWith("two words.")&&name.endsWith(".pyc")));
    assert.ok(compiled.some(name=>name.startsWith("-leading.")&&name.endsWith(".pyc")));
    await assert.rejects(executeAllowedCommand({commandLine,cwd,
      project:{...project,actions:{...project.actions,blocked_commands:["python3 -m py_compile source/two words.py"]}}}),/blocked pattern/u);
    assert.deepEqual(await expandCompileArguments("python3 -m py_compile 'source/*.py'",cwd),
      ["python3","-m","py_compile","source/*.py"]);
    assert.deepEqual(await expandCompileArguments("node source/*.py",cwd),["node","source/*.py"]);
    for (const pattern of ["../*.py","/tmp/*.py","source/**/*.py","missing/*.py"]) {
      await assert.rejects(expandCompileArguments(`python3 -m py_compile ${pattern}`,cwd));
    }
    await fs.symlink(path.join(cwd,"source"),path.join(cwd,"linked"));
    await assert.rejects(expandCompileArguments("python3 -m py_compile linked/*.py",cwd),/symlink/u);
    await fs.symlink(path.join(cwd,"source","two words.py"),path.join(cwd,"source","linked.py"));
    await assert.rejects(expandCompileArguments(commandLine,cwd),/non-symlink/u);
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
});

test("worker capability probe exercises the real shell-free compilation path",async()=>{
 const probes=await probeCommandExecutionCapabilities();
 assert.deepEqual(probes.map(probe=>({id:probe.id,status:probe.status,reason:probe.reason})),[{id:"python-pycompile-glob-v1",status:"passed",reason:null}]);
 assert.match(probes[0]!.digest,/^[a-f0-9]{64}$/u);
 assert.ok(Number.isFinite(Date.parse(probes[0]!.checkedAt)));
});

test("compilation capability retains inherited scratch-cache isolation",async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"compile-inherited-cache-")));
  try{
    const cache=path.join(root,"scratch-cache");
    const moduleUrl=new URL("./command-executor.js",import.meta.url).href;
    const script=`import assert from "node:assert/strict"; import {probeCommandExecutionCapabilities} from ${JSON.stringify(moduleUrl)}; const probes=await probeCommandExecutionCapabilities(); assert.deepEqual(probes.map(({status,reason})=>({status,reason})),[{status:"passed",reason:null}]); console.log("SCOPED_COMPILATION_PROBE_PASSED");`;
    const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{
      cwd:process.cwd(),env:{...process.env,PYTHONPYCACHEPREFIX:cache,PYTHONDONTWRITEBYTECODE:"1"},
      encoding:"utf8",timeout:15_000
    });
    assert.equal(child.error,undefined);
    assert.equal(child.status,0,child.stdout+child.stderr);
    assert.match(child.stdout,/SCOPED_COMPILATION_PROBE_PASSED/u);
    assert.ok((await fs.readdir(cache)).length,"The actual compiler used the inherited scratch cache");
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("compilation wildcard file, inspection and argument bounds fail closed",async()=>{
  const cwd=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"compile-bounds-")));
  try {
    await fs.mkdir(path.join(cwd,"many"));
    await Promise.all(Array.from({length:257},(_,i)=>fs.writeFile(path.join(cwd,"many",`${i}.py`),"x=1\n")));
    await assert.rejects(expandCompileArguments("python3 -m py_compile many/*.py",cwd),/file bound/u);
    await assert.rejects(expandCompileArguments(`python3 -m py_compile ${Array(513).fill("literal.py").join(" ")}`,cwd),/arguments exceed/u);
    await fs.mkdir(path.join(cwd,"entries"));
    await Promise.all(Array.from({length:4097},(_,i)=>fs.mkdir(path.join(cwd,"entries",String(i)))));
    await assert.rejects(expandCompileArguments("python3 -m py_compile entries/*.py",cwd),/inspection bound/u);
  } finally {await fs.rm(cwd,{recursive:true,force:true});}
});

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
