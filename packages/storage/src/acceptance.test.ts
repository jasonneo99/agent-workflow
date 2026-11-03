import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceDigest, acceptanceGate, acceptancePreflight, acceptanceProposal, enrollAcceptanceContract, storedAcceptanceDecision, historicalCheckpointAcceptanceDecision } from "./acceptance.js";
import type { StructuredAcceptanceContract } from "../../model-providers/src/types.js";
import { structuredAcceptanceDecision } from "../../model-providers/src/quality.js";
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';

function fixture(): StructuredAcceptanceContract {
  return { version: 1, contractId: "contract", projectId: "project", originRunId: "run", taskHash: acceptanceDigest("task"), subjectHash: "subject",
    deliverables: [{ id: "delivery", description: "Synthetic delivery", requiredGates: ["implementation", "verification", "packaging", "supervision"], status: "verified", receipts: {}, gaps: [] }] };
}

test('declared recipe verification rejects skipped collection and whitespace substitutes',async()=>{
 const command='python3 -m unittest discover -s tests -p test_synthetic.py -v',other='python3 -m unittest discover -s tests -p test_other.py -v';
 const paths=['tests/test_synthetic.py','tests/test_other.py'];
 const recipes=paths.map((p,i)=>({source_paths:paths,test_paths:[p],commands:[i?other:command],output_paths:[]}));
 const run=async(commands:string[],stderr='Ran 1 test in 0.1s\nOK\n')=>{
  const frozen=fixture();frozen.sourcePaths=paths;
  const observedAt='2026-01-01T00:00:00.000Z';
  const records=commands.map((commandLine,i)=>{const content={commandLine,exitCode:0,timedOut:false,stdout:'',stderr,subjectHash:'subject',sourcePaths:paths,sourceBefore:'subject',sourceAfter:'subject'};
   const ref={artifactUri:`db://synthetic/recipe-${i}`,runId:'run',taskId:'task',stageId:'verification',kind:'command_output' as const,contentHash:acceptanceDigest(content),observedAt,subjectHash:'subject'};return{content,ref};});
  frozen.deliverables[0]!.receipts.verification=records.map(r=>r.ref);
  const client={query:async(sql:string,params:unknown[])=>{
   if(sql.includes('from workflow_runs where'))return {rows:[{projectId:'project',task:'task',metadata:{acceptanceContract:frozen},policy:{actions:{allowed_commands:[command,other,'git diff --check'],verification_recipes:recipes}}}]};
   if(sql.includes('select uri from artifacts'))return {rows:records.filter(r=>r.content.commandLine===params[1]).map(r=>({uri:r.ref.artifactUri}))};
   const record=records.find(r=>r.ref.artifactUri===params[0]);return{rows:record?[{runId:'run',taskId:'task',stageId:'verification',projectId:'project',kind:'command_output',content:record.content,observedAt}]:[]};
  }} as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  return storedAcceptanceDecision(client,'run','verification',{acceptanceContract:frozen});
 };
 assert.equal((await run([command,other])).reason,null);
 assert.notEqual((await run([command,other],'Ran 4 tests in 0.1s\nOK (skipped=4)\n')).reason,null);
 assert.match((await run(['git diff --check'])).reason!,/omits a required scoped recipe/);
 assert.match((await run([command])).reason!,/omits a required scoped recipe/);
});

test('frozen selected pytest rules recompute raw evidence for source-only scope and cannot be omitted',async()=>{
 for(const command of ['python3 scripts/check_environment.py --group portable','"/opt/synthetic tools/venv/bin/python3" -m pytest tests/test_feature.py -q']){
  const run=async(mode:string)=>{
   const frozen=fixture();frozen.sourcePaths=['src/feature.py'];
   const policy=projectConfigSchema.parse({project:{name:'Synthetic frozen parser'},execution:{environments:{profiles:{portable:{kind:'native',platform:'linux/amd64',source_paths:['src','tests','scripts'],readiness:[{argv:['node','--version']}],verification:[{commands:[command],format:'pytest',minimum_tests:2,expected_tests:2}]}}}},actions:{allowed_commands:[command,'git diff --check'],verification_recipes:[{source_paths:['src/feature.py','tests/test_feature.py'],test_paths:['tests/test_feature.py'],commands:[command],output_paths:[]}]}});
   const content:any={commandLine:command,stdout:'2 passed in 0.01s\n',stderr:'',exitCode:0,timedOut:false,sourcePaths:frozen.sourcePaths,sourceBefore:'subject',sourceAfter:'subject',subjectHash:'subject',environment:{profile:'portable'},verificationRecipe:{status:'passed',cases:999,passed:999,skipped:0}};
   if(mode==='omit'){content.commandLine='git diff --check';content.stdout='';delete content.verificationRecipe;delete content.environment;}
   if(mode==='zero')content.stdout='0 passed in 0.01s\n';
   if(mode==='skip')content.stdout='1 passed, 1 skipped in 0.01s\n';
   if(mode==='exit')content.exitCode=1;
   if(mode==='timeout')content.timedOut=true;
   if(mode==='truncated')content.outputTruncated=true;
   if(mode==='missing-profile')delete content.environment;
   if(mode==='unknown-profile')content.environment.profile='unknown';
   if(mode==='inherited-profile')content.environment.profile='constructor';
   if(mode==='toString-profile')content.environment.profile='toString';
   if(mode==='wrong-format')policy.execution.environments!.profiles.portable!.verification[0]!.format='unittest';
   if(mode==='wrong-count')policy.execution.environments!.profiles.portable!.verification[0]!.expected_tests=3;
   if(mode==='ambiguous-profile')policy.execution.environments!.profiles.portable!.verification.push({...policy.execution.environments!.profiles.portable!.verification[0]!});
   if(mode==='failed-metadata')content.verificationRecipe.status='failed';
   if(mode==='changed-source')content.sourceAfter='changed';
   const observedAt='2026-01-01T00:00:00.000Z',uri='db://synthetic/declared-pytest';
   const reference={artifactUri:uri,runId:'run',taskId:'task',stageId:'verification',kind:'command_output' as const,contentHash:acceptanceDigest(content),observedAt,subjectHash:'subject'};
   frozen.deliverables[0]!.receipts.verification=[reference];
   const client={query:async(sql:string)=>{
    if(sql.includes('from workflow_runs where'))return {rows:[{projectId:'project',task:'task',metadata:{acceptanceContract:frozen},policy}]};
    if(sql.includes('select uri from artifacts'))return {rows:[{uri}]};
    return {rows:[{runId:'run',taskId:'task',stageId:'verification',projectId:'project',kind:'command_output',content,observedAt}]};
   }} as unknown as Parameters<typeof storedAcceptanceDecision>[0];
   return storedAcceptanceDecision(client,'run','verification',{acceptanceContract:frozen});
  };
  assert.equal((await run('pass')).reason,null,'Frozen format and raw counts pass despite unrelated claimed metadata counts');
  for(const mode of ['zero','skip','exit','timeout','truncated','missing-profile','unknown-profile','inherited-profile','toString-profile','wrong-format','wrong-count','ambiguous-profile','failed-metadata','changed-source'])assert.notEqual((await run(mode)).reason,null,mode);
  assert.match((await run('omit')).reason??'',/omits a required scoped recipe/,'A source-only task cannot replace its required owner check with an unrelated command');
 }
});

test("supervision stages share the structured gate while advisory stages remain unmapped", () => {
  for (const stage of ["supervise", "supervision", "supervisor"]) assert.equal(acceptanceGate(stage), "supervision");
  assert.equal(acceptanceGate("implement-item-1"), "implementation");
  assert.equal(acceptanceGate("verify_item_1"), "verification");
  assert.equal(acceptanceGate("package-product"), "packaging");
  assert.equal(acceptanceGate("supervisor-audit"), "supervision");
  assert.equal(acceptanceGate("implementationNotes"), null);
  for (const stage of ["orient", "plan", "document"]) assert.equal(acceptanceGate(stage), null);
});

test("canonical verification and packaging stage IDs enforce missing governed gate evidence", async () => {
  const frozen = fixture();
  const client = { query: async () => ({ rows: [{ projectId: "project", task: "task", metadata: { acceptanceContract: frozen } }] }) } as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  for (const [stage, expected] of [["verification", "verification"], ["verification-source", "verification"],
    ["packaging", "packaging"], ["packaging_source", "packaging"]] as const) {
    const gate = acceptanceGate(stage);
    assert.equal(gate, expected);
    assert.match((await storedAcceptanceDecision(client, "run", gate!, { acceptanceContract: frozen })).reason!, /lacks/u,
      `${stage} cannot complete from narrative success without its governed receipts`);
  }
  for (const stage of ["verificationNotes", "packagingNotes", "document-packaging"]) assert.equal(acceptanceGate(stage), null);
});

test("frozen acceptance requirements cannot be removed or changed by the provider", () => {
  const frozen = fixture();
  assert.ok(acceptanceProposal(frozen, structuredClone(frozen)));
  const changed = structuredClone(frozen);
  changed.deliverables = [];
  assert.equal(acceptanceProposal(frozen, changed), null);
  changed.deliverables = structuredClone(frozen.deliverables);
  changed.subjectHash = "different";
  assert.equal(acceptanceProposal(frozen, changed), null);
  assert.equal(acceptanceDigest({ a: 1, b: 2 }), acceptanceDigest({ b: 2, a: 1 }));
});

test("storage acceptance distinguishes legacy from missing structured evidence at every gate", async () => {
  const frozen = fixture();
  const client = (metadata: Record<string, unknown>) => ({ query: async () => ({ rows: [{ projectId: "project", task: "task", metadata }] }) }) as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  assert.deepEqual(await storedAcceptanceDecision(client({}), "run", "supervision", {}), { mode: "legacy", reason: null });
  assert.match((await storedAcceptanceDecision(client({}), "run", "supervision", { acceptanceContract: frozen })).reason!, /cannot enroll/u);
  for (const gate of ["implementation", "verification", "packaging", "supervision"] as const) {
    assert.match((await storedAcceptanceDecision(client({ acceptanceContract: frozen }), "run", gate, {})).reason!, /identity/u);
    assert.match((await storedAcceptanceDecision(client({ acceptanceContract: frozen }), "run", gate, { acceptanceContract: frozen })).reason!, /lacks/u);
    assert.match((await storedAcceptanceDecision(client({ acceptanceContract: frozen }), "other", gate, { acceptanceContract: frozen })).reason!, /ancestry/u);
  }
});

test("all production gates resolve command identity and content rather than trusting supplied receipts", async () => {
  const content = { commandLine: "npm test", exitCode: 0, timedOut: false, subjectHash: "subject" };
  const frozen = fixture();
  const observedAt = "2026-01-01T00:00:00.000Z";
  const reference = { artifactUri: "db://synthetic/check", runId: "run", taskId: "task", stageId: "verify", kind: "command_output" as const,
    contentHash: acceptanceDigest(content), observedAt, subjectHash: "subject" };
  for (const gate of frozen.deliverables[0].requiredGates) frozen.deliverables[0].receipts[gate] = [reference];
  const client = (override: Record<string, unknown> = {}, latestUri = reference.artifactUri) => ({ query: async (sql: string) => ({ rows: sql.includes("select uri from artifacts") ? [{ uri: latestUri }] : sql.includes("from workflow_runs where")
    ? [{ projectId: "project", task: "task", metadata: { acceptanceContract: frozen } }]
    : [{ runId: "run", taskId: "task", stageId: "verify", projectId: "project", kind: "command_output", content, observedAt, ...override }] }) }) as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  for (const gate of frozen.deliverables[0].requiredGates) {
    assert.equal((await storedAcceptanceDecision(client(), "run", gate, { acceptanceContract: frozen })).reason, null);
    assert.notEqual((await storedAcceptanceDecision(client({}, "db://synthetic/newer-failure"), "run", gate, { acceptanceContract: frozen })).reason, null);
    for (const bad of [{ runId: "other" }, { taskId: "other" }, { projectId: "other" }, { kind: "stage_output" },
      { content: { ...content, commandLine: undefined } }, { content: { ...content, commandLine: " " } },
      { content: { ...content, exitCode: 1 } }, { content: { ...content, subjectHash: "old" } }]) {
      assert.notEqual((await storedAcceptanceDecision(client(bad), "run", gate, { acceptanceContract: frozen })).reason, null);
    }
  }
});

test("historical acceptance derives cutoff from exact completion attestation and never changes current checks", async () => {
  const frozen = fixture();
  const content = { commandLine: "npm test", exitCode: 0, timedOut: false, subjectHash: "subject" };
  const reference = { artifactUri: "db://synthetic/check", runId: "run", taskId: "task", stageId: "verify", kind: "command_output" as const,
    contentHash: acceptanceDigest(content), observedAt: "2026-01-01T00:00:00.000Z", subjectHash: "subject" };
  frozen.deliverables[0].receipts.verification = [reference];
  const artifact = { acceptanceContract: frozen };
  const cutoff = "2026-01-01 00:00:01.123456+00";
  const client = (metadata = artifact, completedAt = cutoff, latest = reference.artifactUri, future = false) => ({ query: async (sql: string, args: unknown[]) => {
    if (sql.includes("action_receipts")) return { rows: [{ metadata, completedAt }] };
    if (sql.includes("from workflow_runs where")) return { rows: [{ projectId: "project", task: "task", metadata: { acceptanceContract: frozen } }] };
    assert.match(sql, /\$3::timestamptz/u);
    assert.ok(args[2] === cutoff || args[2] === null);
    if (sql.includes("select uri from artifacts")) return { rows: [{ uri: args[2] ? latest : "db://synthetic/newer" }] };
    return { rows: future ? [] : [{ runId: "run", taskId: "task", stageId: "verify", projectId: "project", kind: "command_output", content, observedAt: reference.observedAt }] };
  } }) as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  assert.equal((await historicalCheckpointAcceptanceDecision(client(), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await storedAcceptanceDecision(client(), "run", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client({ acceptanceContract: fixture() }), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client(artifact, "invalid"), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client(artifact, cutoff, "db://synthetic/newer-before-completion"), "run", "task", "verification", artifact)).reason, null);
  assert.notEqual((await historicalCheckpointAcceptanceDecision(client(artifact, cutoff, reference.artifactUri, true), "run", "task", "verification", artifact)).reason, null);
});

test("enrollment freezes pending requirements before execution and rejects replacement", async () => {
  const contract = fixture();
  contract.deliverables[0].status = "pending";
  let writes = 0;
  const makeClient = (started: boolean, metadata: Record<string, unknown> = {}) => ({ query: async (sql: string) => {
    if (sql.startsWith("update")) { writes++; return { rows: [] }; }
    return { rows: [{ projectId: "project", task: "task", metadata, started }] };
  } }) as unknown as Parameters<typeof enrollAcceptanceContract>[0];
  await enrollAcceptanceContract(makeClient(false), "run", contract);
  assert.equal(writes, 1);
  await enrollAcceptanceContract(makeClient(false, { acceptanceContract: contract }), "run", contract);
  assert.equal(writes, 1);
  await assert.rejects(enrollAcceptanceContract(makeClient(true), "run", contract), /unstarted/u);
  await assert.rejects(enrollAcceptanceContract(makeClient(false, { acceptanceContract: { ...contract, subjectHash: "old" } }), "run", contract), /immutable/u);
  await assert.rejects(enrollAcceptanceContract(makeClient(false), "other", contract), /matching run identity/u);
  const legacy = await acceptancePreflight(makeClient(false), "run", {});
  assert.equal(legacy.accepted, false);
  assert.equal(legacy.decisions.length, 4);
});

test("only frozen advisory criteria warn or inform; required criteria and invalid evidence block", async () => {
  const contract = fixture();
  for (const severity of ["warn", "info"] as const) {
    contract.deliverables[0].advisory = true;
    contract.deliverables[0].severity = severity;
    const decision = await structuredAcceptanceDecision(contract, "verification", async () => null);
    assert.equal(decision.reason, null);
    assert.equal(decision.findings[0].severity, severity);
    assert.equal(decision.findings[0].deliverableId, "delivery");
    const downgraded = structuredClone(contract);
    downgraded.deliverables[0].severity = "block";
    assert.equal(acceptanceProposal(downgraded, contract), null);
  }
  contract.deliverables[0].advisory = false;
  assert.notEqual((await structuredAcceptanceDecision(contract, "verification", async () => null)).reason, null);
  contract.deliverables[0].advisory = true;
  contract.deliverables[0].receipts.verification = [{ artifactUri: "db://missing", runId: "run", taskId: "task", stageId: "verify", kind: "command_output", contentHash: "hash", observedAt: "2026-01-01T00:00:00.000Z", subjectHash: "subject" }];
  assert.notEqual((await structuredAcceptanceDecision(contract, "verification", async () => null)).reason, null);
  contract.deliverables[0].status = "pending";
  assert.notEqual((await structuredAcceptanceDecision(contract, "verification", async () => null)).reason, null);
});

test("production supersession requires equivalent accepted completion before emitting a receipt", async () => {
  const { default: pg } = await import("pg");
  const { supersedeWorkflowRun } = await import("./run-supersession.js");
  const sourceId = "00000000-0000-4000-8000-000000000001";
  const replacementId = "00000000-0000-4000-8000-000000000002";
  const originalConnect = pg.Pool.prototype.connect;
  try {
    for (const scenario of ["queued", "running", "failed", "blocked", "foreign", "task", "requirements", "unverified", "unfinished", "accepted"]) {
      const contract = { ...fixture(), originRunId: replacementId };
      const content = { commandLine: "npm test", exitCode: 0, timedOut: false, subjectHash: contract.subjectHash };
      const reference = { artifactUri: "db://synthetic/supersession-check", runId: replacementId, taskId: "verifier", stageId: "verify", kind: "command_output" as const,
        contentHash: acceptanceDigest(content), observedAt: "2026-01-01T00:00:00.000Z", subjectHash: contract.subjectHash };
      for (const gate of contract.deliverables[0].requiredGates) contract.deliverables[0].receipts[gate] = [reference];
      const sourceContract = { ...structuredClone(contract), originRunId: sourceId };
      if (scenario === "requirements") sourceContract.deliverables[0].description = "Different required work";
      const source = { id: sourceId, projectId: "project", workflowId: "build-feature", task: "task", status: "blocked", contract: sourceContract };
      const replacement = { ...source, id: replacementId, contract, status: ["queued", "running", "failed", "blocked"].includes(scenario) ? scenario : "completed",
        projectId: scenario === "foreign" ? "foreign" : "project", task: scenario === "task" ? "Different task" : "task" };
      const before = JSON.stringify([source, replacement]);
      const receipts: unknown[][] = [];
      const transaction: string[] = [];
      const query = async (sql: string, args: unknown[] = []) => {
        if (["begin", "commit", "rollback"].includes(sql)) transaction.push(sql);
        if (sql.includes("where id=any")) return { rows: [source, replacement] };
        if (sql.includes("as ready")) return { rows: [{ ready: scenario !== "unfinished" }] };
        if (sql.includes("select a.content")) return { rows: [{ content: { acceptanceContract: contract } }] };
        if (sql.includes("evaluation_metadata as metadata")&&sql.includes("from workflow_runs")) return { rows: [{ projectId: "project", task: "task", metadata: { acceptanceContract: contract } }] };
        if (sql.includes("select a.run_id")) return { rows: scenario === "unverified" ? [] : [{ runId: replacementId, taskId: "verifier", stageId: "verify", projectId: "project", kind: "command_output", content, observedAt: reference.observedAt }] };
        if (sql.includes("select uri from artifacts")) return { rows: [{ uri: reference.artifactUri }] };
        if (sql.includes("INSERT INTO run_notifications")) {
          assert.equal(args[0], sourceId, "Supersession notification belongs to the preserved source run");
          return { rows: [{ id: sourceId }], rowCount: 1 };
        }
        if (sql.includes("select wr.id::text")) return { rows: [{ id: sourceId }] };
        if (sql.includes("select id from workflow_runs")) return { rows: [{ id: sourceId }] };
        if (sql.includes("insert into action_receipts")) receipts.push(args);
        return { rows: [], rowCount: 0 };
      };
      pg.Pool.prototype.connect = (async () => ({ query, release() {} })) as unknown as typeof originalConnect;
      const accepted = scenario === "accepted";
      assert.equal(await supersedeWorkflowRun({ runId: sourceId, supersededBy: replacementId, actor: "synthetic-reviewer", reason: "Synthetic independent acceptance" }), accepted, scenario);
      assert.equal(receipts.length, accepted ? 1 : 0, scenario);
      assert.equal(transaction.at(-1), accepted ? "commit" : "rollback", scenario);
      assert.equal(JSON.stringify([source, replacement]), before, "Canonical history inputs remain unchanged");
      if (accepted) {
        assert.equal(receipts[0][2], "failed_run_superseded");
        assert.equal(JSON.parse(String(receipts[0][5])).supersededBy, replacementId);
      }
    }
  } finally {
    pg.Pool.prototype.connect = originalConnect;
  }
});
