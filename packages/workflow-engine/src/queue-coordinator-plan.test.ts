import assert from "node:assert/strict";
import test from "node:test";
import { compareQueueCoordinatorResolution, planQueueCoordinator, type QueueCoordinatorFamily } from "./queue-coordinator-plan.js";

const family = (familyId: string, changes: Partial<QueueCoordinatorFamily> = {}): QueueCoordinatorFamily => ({
  familyId, sourceRunId: `source-${familyId}`, projectId: "project-a", projectRootUri: "/synthetic/project-a", canonical: true,
  activeRunIds: [], pendingApprovalIds: [], fileScopes: [`src/${familyId}.ts`], failureFingerprint: `failure-${familyId}`,
  priorFingerprint: null, repairDepth: 0, verificationReady: false, originalAcceptancePresent: true,
  sourceEvidenceReady: true, blocker: "source correctness defect", ...changes
});

test("five total items include the independent verifier; no input mutation", () => {
  const input = [family("f"), family("e"), family("d"), family("c"), family("a"), family("b"), family("v", { verificationReady: true, repairDepth: 2, priorFingerprint: "failure-v" })];
  const before = JSON.stringify(input);
  const plan = planQueueCoordinator(input);
  assert.deepEqual(plan.repairs.map(p => [p.lane, p.family.familyId]), [[1, "a"], [2, "b"], [3, "c"], [4, "d"]]);
  assert.equal(plan.verifiers[0].family.familyId, "v");
  assert.equal(plan.holds[0].reason, "item capacity");
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(planQueueCoordinator([...input].reverse()), plan);
});
test('active verifier consumes one total item and does not reserve a second verifier ahead of repair backfill',()=>{
 const input=[family('active-verify',{activeRunIds:['live'],verificationReady:true}),family('waiting-verify',{verificationReady:true}),...Array.from({length:6},(_,i)=>family('repair-'+i))];
 const plan=planQueueCoordinator(input,{verifierOccupied:true});assert.equal(plan.verifiers.length,0);assert.equal(plan.repairs.length,4);assert.equal(plan.holds.find(h=>h.familyId==='waiting-verify')?.reason,'verifier capacity');
 for(const maxItems of [0,6,7,8,NaN,1.2])assert.throws(()=>planQueueCoordinator([],{maxItems}));
});
test('rolling refill reuses an actual vacated lane rather than colliding with a still-active last lane',()=>{
 const active=[1,3,4,5].map(lane=>family('active-'+lane,{activeRunIds:['live-'+lane]}));
 const plan=planQueueCoordinator([...active,family('next')],{occupiedRepairLanes:[1,3,4,5]});assert.equal(plan.repairs.length,1);assert.equal(plan.repairs[0].lane,2);
 assert.throws(()=>planQueueCoordinator([],{occupiedRepairLanes:[1,1]}));assert.throws(()=>planQueueCoordinator([],{occupiedRepairLanes:[0]}));
});

test("scope overlap includes active families, parent scopes and unknown globs", () => {
  const plan = planQueueCoordinator([
    family("active", { activeRunIds: ["run"], fileScopes: ["src"] }),
    family("same", { fileScopes: ["src/a.ts"] }),
    family("other", { projectId: "project-b", projectRootUri: "/synthetic/project-b", fileScopes: ["src/a.ts"] })
  ]);
  assert.deepEqual(plan.repairs.map(x => x.family.familyId), ["other"]);
  assert.equal(plan.repairs[0].lane, 2);
  assert.ok(plan.holds.some(x => x.familyId === "same" && x.reason === "overlapping execution scope"));
  assert.equal(planQueueCoordinator([family("a", { fileScopes: ["src/**"] }), family("b")]).repairs.length, 1);
});

test("fail closed on approval, provenance, scope, authority and recursive repairs", () => {
  const cases: Partial<QueueCoordinatorFamily>[] = [
    { canonical: false }, { pendingApprovalIds: ["approval"] }, { sourceEvidenceReady: false },
    { originalAcceptancePresent: false }, { fileScopes: [] }, { fileScopes: ["../secret"] },
    { failureFingerprint: "" }, { repairDepth: 1 }, { priorFingerprint: "failure-x" },
    { blocker: "native acceptance pending" }, { blocker: "deployment required" }, { blocker: "credentials unavailable" }
  ];
  for (const changes of cases) {
    const plan = planQueueCoordinator([family("x", changes)]);
    assert.equal(plan.repairs.length + plan.verifiers.length, 0, JSON.stringify(changes));
    assert.equal(plan.holds.length, 1);
  }
  assert.equal(planQueueCoordinator([family("x", { verificationReady: true, pendingApprovalIds: ["a"] })]).verifiers.length, 0);
});

test("shared cause gets one representative and fanout priority is deterministic", () => {
  const plan = planQueueCoordinator([family("z"), family("b", { sharedBlockerKey: "executor" }), family("a", { sharedBlockerKey: "executor" })], { repairLanes: 1 });
  assert.equal(plan.repairs[0].family.familyId, "a");
  assert.deepEqual(plan.sharedBlockers, [{ key: "executor", familyIds: ["a", "b"] }]);
  assert.equal(plan.holds.find(x => x.familyId === "b")?.reason, "shared blocker representative scheduled first");
  const held = planQueueCoordinator([family("a", { sharedBlockerKey: "x", pendingApprovalIds: ["approval"] }), family("b", { sharedBlockerKey: "x" })]);
  assert.equal(held.repairs.length, 0);
});

test("reject duplicate identities, invalid lanes and ranking metadata", () => {
  assert.throws(() => planQueueCoordinator([family("a"), family("a")]));
  for (const repairLanes of [0, -1, 1.5, 33, NaN]) assert.throws(() => planQueueCoordinator([], { repairLanes }));
  assert.throws(() => planQueueCoordinator([], { verifierLanes: 0 }));
  assert.throws(() => planQueueCoordinator([family("a", { repairDepth: -1 })]));
});

test("verification observes stable source while independent repair and verification remain parallel", () => {
  for (const verifierFirst of [false, true]) {
    const plan = planQueueCoordinator([
      family("repair", { fileScopes: ["shared.ts"], priority: verifierFirst ? 0 : 1 }),
      family("verify", { verificationReady: true, fileScopes: ["shared.ts"], priority: verifierFirst ? 1 : 0 })
    ]);
    assert.equal(plan.repairs.length + plan.verifiers.length, 1);
    assert.equal(plan.holds[0].reason, "overlapping execution scope");
  }
  assert.equal(planQueueCoordinator([
    family("active", { activeRunIds: ["run"], fileScopes: ["shared.ts"] }),
    family("verify", { verificationReady: true, fileScopes: ["shared.ts"] })
  ]).verifiers.length, 0);
  const independent = planQueueCoordinator([family("repair"), family("verify", { verificationReady: true })]);
  assert.equal(independent.repairs.length, 1);
  assert.equal(independent.verifiers.length, 1);
});

test('an exact storage-validated exception only exempts its one foreign quarantined clone',()=>{
 const blocked=family('stranded',{activeRunIds:['preserved-queued-run'],fileScopes:['shared.ts'],reconciliationHoldReason:'exact assignment reconciliation required'});
 const approved=family('approved',{fileScopes:['shared.ts'],quarantineOverlap:{blockedCloneRunId:'preserved-queued-run',authorizationReceiptHash:'a'.repeat(64)}});
 assert.equal(planQueueCoordinator([blocked,approved]).repairs[0]?.family.familyId,'approved');
 for(const other of [{...blocked,reconciliationHoldReason:undefined},{...blocked,activeRunIds:['another']},{...blocked,activeRunIds:['preserved-queued-run','reservation:live']}])
  assert.equal(planQueueCoordinator([other,approved]).repairs.length,0);
 assert.equal(planQueueCoordinator([blocked,{...approved,verificationReady:true}]).verifiers.length,0);
 assert.equal(planQueueCoordinator([blocked,{...approved,quarantineOverlap:{...approved.quarantineOverlap!,authorizationReceiptHash:'invalid'}}]).repairs.length,0);
 assert.equal(planQueueCoordinator([blocked,approved,family('unrelated',{fileScopes:['shared.ts']})]).repairs.length,1);
});
test('proven non-leasable queued lineage frees capacity but never its overlap reservation',()=>{
 const blocked=family('stranded',{activeRunIds:['preserved-queued-run'],fileScopes:['shared.ts'],reconciliationHoldReason:'exact assignment reconciliation required'});
 const input=[blocked,family('overlap',{fileScopes:['shared.ts']}),...Array.from({length:5},(_,n)=>family(`independent-${n}`))];
 const before=JSON.stringify(input),plan=planQueueCoordinator(input);
 assert.deepEqual(plan.repairs.map(p=>p.lane),[1,2,3,4,5]);
 assert.equal(plan.holds.find(h=>h.familyId==='stranded')?.reason,'exact assignment reconciliation required');
 assert.equal(plan.holds.find(h=>h.familyId==='overlap')?.reason,'overlapping execution scope');
 assert.equal(JSON.stringify(input),before);
});
test('admission pressure preserves active ownership and deterministically defers lower-value new work',()=>{
 const active=family('active',{activeRunIds:['running'],priority:0}),high=family('high',{priority:100}),low=family('low',{priority:1}),verify=family('verify',{verificationReady:true,priority:50});
 const limited=planQueueCoordinator([active,low,verify,high],{admission:{storageReady:true,providerReady:true,verifierReady:true,newItemLimit:1}});
 assert.deepEqual(limited.verifiers.map(item=>item.family.familyId),['verify']);assert.equal(limited.repairs.length,0);
 assert.equal(limited.holds.find(item=>item.familyId==='high')?.reason,'admission backpressure');assert.equal(limited.holds.find(item=>item.familyId==='active')?.reason,'family already active');
 const provider=planQueueCoordinator([high,verify],{admission:{storageReady:true,providerReady:false,verifierReady:true,newItemLimit:5}});
 assert.deepEqual(provider.verifiers.map(item=>item.family.familyId),['verify']);assert.equal(provider.holds.find(item=>item.familyId==='high')?.reason,'provider backpressure');
 const verifier=planQueueCoordinator([high,verify],{admission:{storageReady:true,providerReady:true,verifierReady:false,newItemLimit:5}});
 assert.deepEqual(verifier.repairs.map(item=>item.family.familyId),['high']);assert.equal(verifier.holds.find(item=>item.familyId==='verify')?.reason,'verifier backpressure');
 const storage=planQueueCoordinator([high,verify],{admission:{storageReady:false,providerReady:true,verifierReady:true,newItemLimit:5}});
 assert.equal(storage.repairs.length+storage.verifiers.length,0);assert.ok(storage.holds.every(item=>item.reason==='storage backpressure'));
 for(const newItemLimit of [-1,8,1.5])assert.throws(()=>planQueueCoordinator([],{admission:{storageReady:true,providerReady:true,verifierReady:true,newItemLimit}}));
});
test('provider backpressure is scoped to the family required provider',()=>{
 const codex=family('codex',{requiredProvider:'codex-cli'}),anthropic=family('anthropic',{requiredProvider:'anthropic'});
 const plan=planQueueCoordinator([codex,anthropic],{admission:{storageReady:true,providerReady:true,verifierReady:true,newItemLimit:5,availableProviders:['anthropic'],unavailableProviders:['codex-cli']}});
 assert.deepEqual(plan.repairs.map(item=>item.family.familyId),['anthropic']);assert.equal(plan.holds.find(item=>item.familyId==='codex')?.reason,'provider backpressure');
});

test('actionable blocked resolution outranks fresh work and oldest blockers win without discovery churn',()=>{
 const fresh=family('fresh',{priority:1000,resolutionStrategy:'fresh-delivery'});
 const newer=family('newer-blocked',{blockedSince:'2026-10-26T12:00:00.000Z',resolutionStrategy:'repair-exact-source',nonResolvingAttempts:0});
 const older=family('older-blocked',{blockedSince:'2026-10-25T12:00:00.000Z',resolutionStrategy:'repair-exact-source',nonResolvingAttempts:0});
 const churn=family('discovery-churn',{blockedSince:'2026-10-24T12:00:00.000Z',resolutionStrategy:'discover-missing-scope',nonResolvingAttempts:3});
 const plan=planQueueCoordinator([fresh,newer,churn,older],{repairLanes:2,maxItems:2});
 assert.deepEqual(plan.repairs.map(item=>item.family.familyId),['older-blocked','newer-blocked']);
 assert.equal(plan.holds.find(item=>item.familyId==='fresh')?.reason,'item capacity');
 assert.equal(plan.holds.find(item=>item.familyId==='discovery-churn')?.reason,'item capacity');
});

test('sealed verification and effect reconciliation outrank another source repair',()=>{
 const plan=planQueueCoordinator([
  family('repair',{blockedSince:'2026-10-20T00:00:00.000Z',resolutionStrategy:'repair-exact-source'}),
  family('reconcile',{blockedSince:'2026-10-21T00:00:00.000Z',resolutionStrategy:'reconcile-owned-effects'}),
  family('verify',{blockedSince:'2026-10-22T00:00:00.000Z',resolutionStrategy:'verify-sealed-candidate',verificationReady:true})
 ],{repairLanes:1,verifierLanes:1,maxItems:2});
 assert.deepEqual(plan.verifiers.map(item=>item.family.familyId),['verify']);
 assert.deepEqual(plan.repairs.map(item=>item.family.familyId),['reconcile']);
});
test('autonomous recovery can reuse the same blocked-resolution ordering',()=>{
 const candidates=[family('fresh',{priority:999,resolutionStrategy:'fresh-delivery'}),family('blocked',{blockedSince:'2026-10-25T00:00:00.000Z',resolutionStrategy:'repair-exact-source'})];
 assert.deepEqual(candidates.sort((a,b)=>compareQueueCoordinatorResolution(a,b)).map(item=>item.familyId),['blocked','fresh']);
});
test('confidence-qualified adaptive order is only a tie-breaker among otherwise eligible strategies',()=>{
 const reconcile=family('reconcile',{blockedSince:'2026-10-25T00:00:00.000Z',resolutionStrategy:'reconcile-owned-effects'});
 const repair=family('repair',{blockedSince:'2026-10-25T00:00:00.000Z',resolutionStrategy:'repair-exact-source'});
 const gated=family('gated',{blockedSince:'2026-10-25T00:00:00.000Z',resolutionStrategy:'repair-exact-source',pendingApprovalIds:['approval']});
 const plan=planQueueCoordinator([reconcile,repair,gated],{repairLanes:1,maxItems:1,adaptiveStrategyOrder:['repair-exact-source','reconcile-owned-effects']});
 assert.deepEqual(plan.repairs.map(item=>item.family.familyId),['repair']);
 assert.equal(plan.holds.find(item=>item.familyId==='gated')?.reason,'pending approval');
});
