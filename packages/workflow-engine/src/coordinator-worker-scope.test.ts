import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function storageFunction(file: string, name: string): string {
  const source = readFileSync(new URL(`../../storage/src/${file}`, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${file} must declare ${name}`);
  return source.slice(declaration.getStart(parsed), declaration.end);
}

test("exact-run workers do not recover unrelated expired leases", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const worker = source.slice(source.indexOf("export async function runWorkerOnce"), source.indexOf("result.claimed += 1"));
  assert.match(worker, /if \(options\?\.runId === undefined && options\?\.recoverExpiredLeases !== false\)/u);
  assert.match(worker, /claimNextWorkflowTask\(\{\s*\.\.\.options,/u);
  assert.match(worker, /runWorkerOnceConcurrently\(safeLimit, \{ \.\.\.options,/u);
});

test("exact-run claims bind UUID before selection without dropping existing guards", () => {
  const claim = storageFunction("postgres.ts", "claimNextWorkflowTask");
  assert.match(claim, /runId\?: string/u);
  assert.match(claim, /input\?\.runId === undefined \? null : input\.runId\.trim\(\)/u);
  assert.match(claim, /throw new Error\("Exact worker runId must be a UUID"\)/u);
  assert.match(claim, /and \(\$9::uuid is null or wr\.id = \$9::uuid\)/u);
  assert.match(claim, /workerPlatform\]\.concat\(\[runId\]\)/u);
  for (const guard of ["p.root_uri = $3", "allowed_platforms", "cardinality($4::text[])", "project_active.status in ('leased', 'running')", "prior.status <> 'completed'", "for update of wt skip locked"]) {
    assert.ok(claim.includes(guard), `Missing existing claim guard: ${guard}`);
  }
});

test("coordinator children require exact claim, matching worker and live assignment intent at effects", () => {
  const predicate = storageFunction("workflow-task-authority.ts", "coordinatorWorkerFencePredicate");
  assert.match(predicate, /to_regclass\('queue_coordinator_assignments'\)/u);
  assert.match(predicate, /if \(!available\) return "not .*queueCoordinatorClaimId/u);
  for (const guard of ["intent.project_id=assignment.project_id", "intent.owner=assignment.owner", "intent.fencing_token::text=assignment.intent_fence", "intent.expires_at>now()", "assignment.child_run_id=wr.id", "assignment.project_id=wr.project_id", "assignment.fence::text=wr.evaluation_metadata->>'queueCoordinatorFence'", "assignment.state='running'", "assignment.owner || ':' || assignment.fence::text"]) {
    assert.ok(predicate.includes(guard), `Missing coordinator fence: ${guard}`);
  }
  const claim = storageFunction("postgres.ts", "claimNextWorkflowTask");
  assert.ok(claim.includes("or $9::uuid=wr.id)"));
  assert.ok(claim.includes('coordinatorWorkerFencePredicate(client, "$1")'));
  assert.ok(claim.includes("and ${coordinatorFence}"));
  const effect = storageFunction("workflow-task-authority.ts", "lockWorkflowTaskClaim");
  assert.ok(effect.includes('coordinatorWorkerFencePredicate(client, "$3")'));
  assert.ok(effect.includes("and ${coordinatorFence}"));
  assert.match(storageFunction("workflow-task-authority.ts", "assertActiveTaskFence"), /lockWorkflowTaskClaim\(client, input, \['running'\]\)/u);
});

test("strict provider authorization covers every execution and disables environment chains", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const fileActions = readFileSync(new URL("./stage-file-actions.ts", import.meta.url), "utf8");
  assert.ok(source.includes("strictProviderIds === undefined ? configuredFallbackPolicy : { ...configuredFallbackPolicy, chains: {} }"));
  assert.ok(source.includes("strictProviderIds !== undefined && !strictProviderIds.has(providerId)"));
  assert.ok(source.includes("strictProviderIds.has(configuredQualityFallbackProviderId)"));
  const fallbackFactories = (file: string, text: string): string[] => {
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), factories: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "executeWithProviderFallback") {
        const input = node.arguments[0];
        assert.ok(input && ts.isObjectLiteralExpression(input), `${file}: fallback call needs explicit arguments`);
        const factory = input.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(parsed) === "providerFactory");
        assert.ok(factory && ts.isPropertyAssignment(factory), `${file}: fallback call needs its guarded factory`);
        assert.ok(ts.isIdentifier(factory.initializer), `${file}: fallback factory must remain the supplied reference`);
        factories.push(factory.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    return factories;
  };
  const rootCalls = fallbackFactories("executor.ts", source);
  const fileCalls = fallbackFactories("stage-file-actions.ts", fileActions);
  const calls = [...rootCalls, ...fileCalls];
  assert.equal(rootCalls.length, 10);
  assert.equal(fileCalls.length, 2);
  assert.equal(calls.length, 12);
  assert.ok(calls.every(factory => factory === "guardedProviderFactory"));
  assert.match(source, /executeStageFileWrites\(\{[\s\S]+route, routedStageInput, fallbackPolicy, guardedProviderFactory,/u);
  assert.match(fileActions, /guardedProviderFactory: NonNullable<FallbackInput\["providerFactory"\]>/u);
  assert.doesNotMatch(fileActions, /providerFromEnv|providerFallbackPolicyFromEnv/u);
  assert.ok(source.includes("return providerWithInfluence(providerFromEnv(providerId));"));
});
