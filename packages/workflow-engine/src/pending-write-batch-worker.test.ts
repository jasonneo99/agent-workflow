import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const at = (relative: string) => pathToFileURL(path.join(repository, relative)).href;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scenarios = ["complete", "stale-tail", "prior-success"];

test("actual worker retains a corrected write batch before executing its dependent check", async t => {
  if (!process.env.AGENTFLOW_BATCH_WORKER_ROOT) {
    for (const scenario of scenarios) await t.test(scenario, async subtest => {
      const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "write-batch-worker-")));
      subtest.after(() => fs.rm(owned, { recursive: true, force: true }));
      const home = path.join(owned, "home"); await fs.mkdir(home);
      const env: NodeJS.ProcessEnv = { AGENTFLOW_BATCH_WORKER_ROOT: owned, AGENTFLOW_BATCH_WORKER_CASE: scenario, HOME: home,
        DEFAULT_MODEL_PROVIDER: "mock", AGENTFLOW_FILE_MUTATION_RETRY_BUDGET: "1" };
      for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)],
        { env, encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
      const output = (child.stdout ?? "") + (child.stderr ?? "");
      console.log(output.split("\n").find(line => line.startsWith("WRITE_BATCH_WORKER_OBSERVATION")) ?? output.slice(-3000));
      assert.equal(child.error, undefined); assert.equal(child.status, 0, output);
    });
    return;
  }
  const scenario = process.env.AGENTFLOW_BATCH_WORKER_CASE!; assert.ok(scenarios.includes(scenario));
  const owned = process.env.AGENTFLOW_BATCH_WORKER_ROOT, canonical = path.join(owned, "project");
  await fs.mkdir(path.join(canonical, "src"), { recursive: true }); await fs.mkdir(path.join(canonical, "tests"));
  const paths = ["src/first.txt", "src/second.txt", "src/third.txt"], before = "before\n", after = "after\n";
  for (const relative of paths) await fs.writeFile(path.join(canonical, relative), before);
  await fs.writeFile(path.join(canonical, "tests/batch.test.mjs"),
    "import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';" +
    "test('the complete write batch is visible',()=>{for(const name of ['first','second','third'])" +
    "assert.equal(fs.readFileSync(new URL('../src/'+name+'.txt',import.meta.url),'utf8'),'after\\n',name);" +
    "console.log('BATCH_CHECK_OBSERVED');});\n");
  await fs.writeFile(path.join(canonical, ".gitignore"), ".agent-workflow/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: canonical, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Synthetic Developer"); git("config", "user.email", "dev@example.com");
  git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", ".git/test-hooks");
  git("add", "."); git("commit", "-m", "Synthetic batch baseline"); const canonicalHead = git("rev-parse", "HEAD");
  const { projectConfigSchema } = await import(at("packages/agent-registry/src/schemas.ts"));
  const { planRunEnvironment, ENVIRONMENT_COMMAND } = await import(at("packages/run-environments/src/index.ts"));
  const { prepareRunWorkspace } = await import(at("packages/run-environments/src/workspace.ts"));
  const { REPAIR_COMMIT_COMMAND } = await import(at("packages/run-environments/src/repair-checkpoint.ts"));
  const command = "node --test tests/batch.test.mjs";
  const project = projectConfigSchema.parse({ project: { name: "Synthetic write batch" },
    execution: { repair_commits: { enabled: true, stages: ["repair"] }, environments: { default_profile: "native", profiles: {
      native: { kind: "native", platform: process.platform + "/" + (process.arch === "x64" ? "amd64" : process.arch),
        source_paths: ["src", "tests"], readiness: [{ argv: ["node", "--version"] }],
        verification: [{ commands: [command], format: "node-test", expected_tests: 1 }] }
    } } }, policies: { require_approval_for_external_actions: false },
    actions: { allowed_commands: [command, "node --version", ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND], allowed_write_paths: paths } });
  await fs.mkdir(path.join(canonical, ".agent-workflow"));
  await fs.writeFile(path.join(canonical, ".agent-workflow/project.yaml"), JSON.stringify(project));
  await fs.writeFile(path.join(owned, "trusted.yaml"), "commands: []\n"); process.env.AGENTFLOW_TRUSTED_COMMANDS_FILE = path.join(owned, "trusted.yaml");
  const runId = "synthetic-write-batch-run", taskId = "synthetic-write-batch-task";
  const plan = await planRunEnvironment({ cwd: canonical, project, context: { runId } });
  const workspace = await prepareRunWorkspace({ canonicalRoot: canonical, runId, plans: [plan], runtimeRoot: path.join(owned, "workspaces"), assertAuthority: async () => {} });
  const task: any = { runId, taskId, stageId: "repair", checkpointAfter: true, agentId: "implementation-agent", agentName: "Synthetic Implementer",
    agentPrompt: "Update only the fixture batch", workflowId: "repair-blocked-item", workflowTask: "Update all three fixture files and verify the complete batch.",
    stageGoal: "Finalize the whole write batch before checks", compiledBrief: "Synthetic governed batch fixture", projectId: "synthetic-project",
    projectRootUri: canonical, workerId: "synthetic-worker", fencingToken: "1", priorReceipts: [], projectConfig: project,
    stagePattern: { type: "react", maxIterations: 8, requiresVerifier: false, promotionGate: "none", stopConditions: [] },
    executionPipeline: { version: 1, required: true, isolation: "worktree", sourceChanges: true, sourcePaths: paths, checkpointStageIds: ["repair"] }, executionWritePaths: paths };
  const records: any[] = [], artifacts = new Map<string, any>(), effects = new Map<string, any>();
  let completed: any, blocked: any, failed: any, calls = 0;
  const replace = async (relative: string, overrides: Record<string, unknown>, strict = false) => {
    const url = at(relative), original = await import(url);
    const defaults = strict ? Object.fromEntries(Object.entries(original).map(([key, value]) => [key,
      typeof value === "function" ? () => { throw Error("Unexpected external boundary " + key); } : value])) : original;
    t.mock.module(url, { namedExports: { ...defaults, ...overrides } });
  };
  await replace("packages/storage/src/client.ts", { withClient: async (fn: any) => fn({ query: async (sql: string) => {
    if (sql.includes("to_regclass")) return { rows: [] };
    assert.match(sql, /from artifacts a/u);
    return { rows: records.filter(r => r.artifactKind === "file_write").map(r => ({ runId, taskId, stageId: "repair", kind: "file_write", uri: r.uri,
      content: { ...r.artifactContent, idempotencyKey: r.idempotencyKey }, status: effects.get(r.idempotencyKey)?.status,
      operation: "file_write", receipt: effects.get(r.idempotencyKey)?.receipt })) };
  } }) }, true);
  await replace("packages/storage/src/postgres.ts", {
    claimNextWorkflowTask: async () => task, startWorkflowTask: async () => {}, assertWorkflowTaskLease: async () => {}, renewWorkflowTaskLease: async () => true,
    getArtifactByUri: async (uri: string) => artifacts.get(uri) ?? null,
    findRunActionByIdempotencyKey: async (input: any) => [...artifacts.values()].find(r => r.idempotencyKey === input.idempotencyKey && r.kind === input.artifactKind) ?? null,
    recordRunAction: async (input: any) => {
      const uri = "db://synthetic-batch/" + records.length;
      records.push({ ...input, uri }); artifacts.set(uri, { uri, runId, taskId, kind: input.artifactKind,
        idempotencyKey: input.idempotencyKey, content: { ...input.artifactContent, idempotencyKey: input.idempotencyKey } }); return uri;
    },
    claimSideEffect: async (input: any) => { const previous = effects.get(input.idempotencyKey); if (previous) return previous;
      const result = { ...input, status: "claimed", claimToken: "synthetic-" + effects.size }; effects.set(input.idempotencyKey, result); return result; },
    getSideEffectReceipt: async (input: any) => effects.get(input.idempotencyKey) ?? null,
    finalizeSideEffect: async (input: any) => { const previous = effects.get(input.idempotencyKey); assert.equal(input.claimToken, previous.claimToken);
      effects.set(input.idempotencyKey, { ...previous, status: "completed", receipt: input.receipt }); return true; },
    withProjectExecutionLock: async (_: any, fn: any) => fn(), dismissSupersededActionApprovals: async () => {},
    completeWorkflowTask: async (input: any) => { completed = input; }, blockWorkflowTask: async (input: any) => { blocked = input; },
    failWorkflowTask: async (input: any) => { failed = input; }
  }, true);
  await replace("packages/workflow-engine/src/stage-authority.ts", { createRenewingStageAuthority: async () => async () => {} });
  await replace("packages/workflow-engine/src/run-preparation.ts", { prepareTaskExecution: async () => ({ root: workspace.root, workspace, commands: [command],
    beforeWrite: async (relative: string) => assert.ok(paths.includes(relative)), assertAuthority: async () => {}, release: async () => {} }) });
  await replace("packages/workflow-engine/src/recovery-evidence.ts", { recoveryEvidence: async () => "" });
  await replace("packages/workflow-engine/src/fleet-usage.ts", { recordDirectProviderUsage: async () => 0 });
  await replace("packages/workflow-engine/src/memory-graph-wiring.ts", { buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {} });
  await replace("packages/model-providers/src/routing.ts", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "standard", reason: "Synthetic batch fixture" }) });
  await replace("packages/model-providers/src/index.ts", { providerFromEnv: () => { throw Error("No real provider permitted"); }, executeWithProviderFallback: async ({ stageInput }: any) => {
    calls++;
    const corrected = { path: paths[0], content: null, patch: "@@ -1 +1 @@\n-before\n+after\n", expectedHash: digest(before) };
    const stale = { path: paths[0], content: null, patch: "@@ -1 +1 @@\n-after\n+final\n", expectedHash: "0".repeat(64) };
    if (calls > 2 && scenario === "complete") {
      assert.ok(stageInput.priorReceipts.some((r: any) => r.summary.includes("BATCH_CHECK_OBSERVED")));
      for (const relative of paths) assert.equal(stageInput.fileReads.find((r: any) => r.path === relative)?.content, after);
    }
    return { output: { outcome: "completed", summary: "Update the authorized batch and consume the actual behavioral check.",
      artifact: { findings: ["Synthetic batch evidence"], nextAction: "Retain only verified source evidence" },
      requestedCommands: calls === 1 ? [command] : [], requestedFileWrites: calls === 1
        ? [...(scenario === "prior-success" ? [{ path: paths[0], content: after }] : []),
          { ...corrected, expectedHash: digest(scenario === "prior-success" ? after : before), patch: "@@ -1 +1 @@\n-not-the-preimage\n+after\n" },
          ...(scenario === "stale-tail" ? [stale] : []), ...paths.slice(1).map(p => ({ path: p, content: after }))]
        : calls === 2 ? [scenario === "prior-success" ? stale : corrected] : [] }, attempts: [], actualProvider: "mock", actualModel: "synthetic", fallbackUsed: false };
  } });
  const { runWorkerOnce } = await import(at("packages/workflow-engine/src/executor.ts"));
  const result = await runWorkerOnce(1, { recoverExpiredLeases: false });
  const commands = records.filter(r => r.artifactKind === "command_output" && r.artifactContent.commandLine === command);
  const writes = records.filter(r => r.artifactKind === "file_write");
  console.log("WRITE_BATCH_WORKER_OBSERVATION " + JSON.stringify({ scenario, result, calls, writes: writes.map(r => r.target),
    commandExits: commands.map(r => r.artifactContent.exitCode), failed, blockedReason: blocked?.reason }));
  assert.equal(failed, undefined);
  if (scenario !== "complete") {
    assert.equal(commands.length, 0, "A successful write to the same path, in this or an earlier round, cannot satisfy a different stale mutation");
    assert.equal(result.completed, 0); assert.ok(blocked); return;
  }
  assert.equal(result.completed, 1, "The whole corrected batch must precede its behavioral check");
  assert.equal(blocked, undefined); assert.ok(completed); assert.equal(calls, 3);
  assert.deepEqual(writes.map(r => r.target), paths); assert.equal(commands.length, 1); assert.equal(commands[0].artifactContent.exitCode, 0);
  assert.match(commands[0].artifactContent.stdout, /BATCH_CHECK_OBSERVED/u);
  assert.ok(records.find(r => r.artifactKind === "repair_commit_candidate"));
  assert.equal(git("rev-parse", "HEAD"), canonicalHead); assert.equal(git("status", "--porcelain"), "");
});
