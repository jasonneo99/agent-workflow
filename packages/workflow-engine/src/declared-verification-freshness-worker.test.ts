import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const at = (relative: string) => pathToFileURL(path.join(repository, relative)).href;

test("actual worker refreshes verification and Git observations without replaying arbitrary effects", async t => {
  if (!process.env.AGENTFLOW_DECLARED_WORKER_ROOT) {
    for (const scenario of ["fresh", "stale-evidence"]) await t.test(scenario, async subtest => {
      const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "declared-verification-worker-")));
      subtest.after(() => fs.rm(owned, { recursive: true, force: true }));
      const home = path.join(owned, "home"); await fs.mkdir(home);
      const env: NodeJS.ProcessEnv = { AGENTFLOW_DECLARED_WORKER_ROOT: owned, AGENTFLOW_DECLARED_WORKER_CASE: scenario,
        HOME: home, DEFAULT_MODEL_PROVIDER: "mock", AGENTFLOW_FALLBACK_PROVIDER: "mock" };
      for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)],
        { env, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      const output = (child.stdout ?? "") + (child.stderr ?? "");
      console.log(output.split("\n").find(line => line.startsWith("DECLARED_VERIFICATION_WORKER_OBSERVATION")) ?? output.slice(-4000));
      assert.equal(child.error, undefined); assert.equal(child.status, 0, output);
    });
    return;
  }
  const owned = process.env.AGENTFLOW_DECLARED_WORKER_ROOT;
  const scenario = process.env.AGENTFLOW_DECLARED_WORKER_CASE;
  assert.ok(scenario === "fresh" || scenario === "stale-evidence");
  const canonical = path.join(owned, "project"), paths = ["src/first.txt", "src/second.txt"];
  for (const directory of ["src", "scripts"]) await fs.mkdir(path.join(canonical, directory), { recursive: true });
  for (const relative of paths) await fs.writeFile(path.join(canonical, relative), "before\n");
  await fs.writeFile(path.join(canonical, "scripts/check_source.py"),
    "from pathlib import Path\n" +
    "first = Path('src/first.txt').read_text()\nsecond = Path('src/second.txt').read_text()\n" +
    "assert first == second and first in ('before\\n', 'after\\n')\n" +
    "print('CHECK_SOURCE_' + first.strip())\nprint('1 passed in 0.01s')\n");
  await fs.writeFile(path.join(canonical, "scripts/record_effect.py"),
    "from pathlib import Path\np = Path('.agent-workflow/runtime/effect-count')\n" +
    "p.parent.mkdir(parents=True, exist_ok=True)\n" +
    "p.write_text(str(int(p.read_text()) + 1) if p.exists() else '1')\nprint('EFFECT_RECORDED')\n");
  await fs.writeFile(path.join(canonical, ".gitignore"), ".agent-workflow/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: canonical, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Synthetic Developer");
  git("config", "user.email", "developer@example.com"); git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", ".git/test-hooks"); git("add", "."); git("commit", "-m", "Synthetic source baseline");
  const canonicalHead = git("rev-parse", "HEAD");
  const { projectConfigSchema } = await import(at("packages/agent-registry/src/schemas.ts"));
  const { planRunEnvironment, ENVIRONMENT_COMMAND } = await import(at("packages/run-environments/src/index.ts"));
  const { prepareRunWorkspace } = await import(at("packages/run-environments/src/workspace.ts"));
  const { REPAIR_COMMIT_COMMAND } = await import(at("packages/run-environments/src/repair-checkpoint.ts"));
  const command = "python3 scripts/check_source.py --group portable", effectCommand = "python3 scripts/record_effect.py";
  const hashCommand = "git hash-object src/first.txt src/second.txt";
  const project = projectConfigSchema.parse({ project: { name: "Synthetic declared verification" },
    execution: { repair_commits: { enabled: true, stages: ["repair"] }, environments: { default_profile: "native", profiles: {
      native: { kind: "native", platform: process.platform + "/" + (process.arch === "x64" ? "amd64" : process.arch),
        source_paths: ["src", "scripts"], readiness: [{ argv: ["python3", "--version"] }],
        verification: [{ commands: [command], format: "pytest", expected_tests: 1 }] }
    } } }, policies: { require_approval_for_external_actions: false },
    actions: { allowed_commands: [command, effectCommand, hashCommand, "python3 --version", ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND], allowed_write_paths: paths } });
  await fs.mkdir(path.join(canonical, ".agent-workflow"));
  await fs.writeFile(path.join(canonical, ".agent-workflow/project.yaml"), JSON.stringify(project));
  await fs.writeFile(path.join(owned, "trusted.yaml"), "commands: []\n"); process.env.AGENTFLOW_TRUSTED_COMMANDS_FILE = path.join(owned, "trusted.yaml");
  const runId = "synthetic-declared-run", taskId = "synthetic-declared-task";
  const plan = await planRunEnvironment({ cwd: canonical, project, context: { runId } });
  const workspace = await prepareRunWorkspace({ canonicalRoot: canonical, runId, plans: [plan], runtimeRoot: path.join(owned, "workspaces"), assertAuthority: async () => {} });
  const task: any = { runId, taskId, stageId: "repair", checkpointAfter: true, agentId: "implementation-agent", agentName: "Synthetic Implementer",
    agentPrompt: "Update only both fixture files", workflowId: "repair-blocked-item", workflowTask: "Update both files and verify their current source.",
    stageGoal: "Consume actual current-source verification", compiledBrief: "Synthetic source freshness fixture", projectId: "synthetic-project",
    projectRootUri: canonical, workerId: "synthetic-worker", fencingToken: "1", priorReceipts: [], projectConfig: project,
    stagePattern: { type: "react", maxIterations: 10, requiresVerifier: false, promotionGate: "none", stopConditions: [] },
    executionPipeline: { version: 1, required: true, isolation: "worktree", sourceChanges: true, sourcePaths: paths, checkpointStageIds: ["repair"] }, executionWritePaths: paths };
  const records: any[] = [], artifacts = new Map<string, any>(), effects = new Map<string, any>();
  let completed: any, blocked: any, failed: any, calls = 0, checkerInvocations = 0, baselineResult: any;
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
      const uri = "db://synthetic-declared/" + records.length;
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
  await replace("packages/model-providers/src/routing.ts", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "standard", reason: "Synthetic source freshness" }) });
  const commandExecutor = await import(at("packages/local-tools/src/command-executor.ts"));
  await replace("packages/local-tools/src/command-executor.ts", { executeAllowedCommand: async (input: any) => {
    if (input.commandLine === command) {
      checkerInvocations++;
      if (scenario === "stale-evidence" && checkerInvocations > 1) return baselineResult;
    }
    const result = await commandExecutor.executeAllowedCommand(input);
    if (input.commandLine === command && !baselineResult) baselineResult = result;
    return result;
  } });
  await replace("packages/model-providers/src/index.ts", { providerFromEnv: () => { throw Error("No real provider permitted"); }, executeWithProviderFallback: async () => {
    calls++;
    return { output: { outcome: "completed", summary: "Consume the governed fixture source and actual checker results.", artifact: { findings: ["Synthetic current-source evidence"] },
      requestedCommands: calls === 1 ? [command, effectCommand, hashCommand] : calls === 3 ? [effectCommand]
        : calls === 4 ? [command, effectCommand, hashCommand] : calls === 5 ? [hashCommand] : [],
      requestedFileWrites: calls === 2 ? paths.map(relative => ({ path: relative, content: "after\n" })) : [] },
      attempts: [], actualProvider: "mock", actualModel: "synthetic", fallbackUsed: false };
  } });
  const { runWorkerOnce } = await import(at("packages/workflow-engine/src/executor.ts"));
  const result = await runWorkerOnce(1, { recoverExpiredLeases: false });
  const checks = records.filter(r => r.artifactKind === "command_output" && r.artifactContent.commandLine === command);
  const other = records.filter(r => r.artifactKind === "command_output" && r.artifactContent.commandLine === effectCommand);
  const hashes = records.filter(r => r.artifactKind === "command_output" && r.artifactContent.commandLine === hashCommand);
  const hashReuses = records.filter(r => r.artifactKind === "action_reuse" && r.artifactContent.target === hashCommand);
  console.log("DECLARED_VERIFICATION_WORKER_OBSERVATION " + JSON.stringify({ scenario, result, calls, checkerInvocations,
    checks: checks.map(r => ({ source: r.artifactContent.environment?.sourceHash, stdout: r.artifactContent.stdout, subject: r.artifactContent.governedWriteSubject })),
    hashes: hashes.map(r => ({ stdout: r.artifactContent.stdout, subject: r.artifactContent.governedWriteSubject })),
    hashReuses: hashReuses.length, effectExecutions: other.length, blockedReason: blocked?.reason, failed }));
  assert.equal(failed, undefined);
  const blob = (text: string) => createHash(canonicalHead.length === 64 ? "sha256" : "sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  const beforeBlob = blob("before\n"), afterBlob = blob("after\n");
  assert.equal(hashes.length, 2, "Source hashing executes once for each governed source version");
  assert.deepEqual(hashes.map(r => r.artifactContent.stdout.trim().split(/\s+/u)),
    [[beforeBlob, beforeBlob], [afterBlob, afterBlob]], "Git observations must describe the actual current bytes");
  assert.notEqual(hashes[0]!.idempotencyKey, hashes[1]!.idempotencyKey);
  assert.equal(hashReuses.length, 1, "An unchanged third observation does not execute Git again");
  assert.equal(hashReuses[0]!.artifactContent.originalArtifactUri, hashes[1]!.uri, "Reuse selects the new source observation, not baseline");
  assert.ok(checks[0]?.artifactContent.stdout.includes("CHECK_SOURCE_before"));
  assert.equal(checkerInvocations, 2, "A changed source executes its declared checker once; unchanged repeats reuse evidence");
  assert.equal(checks.length, 2, "Both immutable baseline and post-write command observations remain recorded");
  assert.equal(other.length, 1, "An arbitrary allowed Python effect is not verification and must not repeat after source writes");
  assert.equal(await fs.readFile(path.join(workspace.root, ".agent-workflow/runtime/effect-count"), "utf8"), "1");
  if (scenario === "stale-evidence") {
    assert.equal(result.completed, 0); assert.equal(completed, undefined); assert.ok(blocked);
    assert.match(blocked.reason, /source|validation|hash|checkpoint|evidence/iu);
    assert.equal(records.some(r => r.artifactKind === "repair_commit_candidate"), false, "Baseline-only evidence cannot checkpoint changed source");
  } else {
    assert.equal(result.completed, 1); assert.equal(blocked, undefined); assert.ok(completed);
    assert.match(checks[1]!.artifactContent.stdout, /CHECK_SOURCE_after/u);
    assert.notEqual(checks[1]!.artifactContent.environment.sourceHash, checks[0]!.artifactContent.environment.sourceHash);
    assert.ok(records.find(r => r.artifactKind === "repair_commit_candidate"));
  }
  assert.equal(git("rev-parse", "HEAD"), canonicalHead); assert.equal(git("status", "--porcelain"), "");
});
