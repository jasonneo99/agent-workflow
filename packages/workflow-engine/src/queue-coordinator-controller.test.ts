import assert from "node:assert/strict";
import test from "node:test";
import { executeQueueCoordinatorPlan, type QueueCoordinatorAdapter } from "./queue-coordinator-controller.js";
import { planQueueCoordinator, type QueueCoordinatorFamily } from "./queue-coordinator-plan.js";

const family = (familyId: string, verificationReady = false): QueueCoordinatorFamily => ({ familyId, sourceRunId: familyId, projectId: "synthetic", projectRootUri: "/synthetic", canonical: true, activeRunIds: [], pendingApprovalIds: [], fileScopes: [`${familyId}.ts`], failureFingerprint: familyId, priorFingerprint: null, repairDepth: 0, verificationReady, originalAcceptancePresent: true, sourceEvidenceReady: true, blocker: "source defect" });
const plan = () => planQueueCoordinator([family("a"), family("b"), family("c"), family("d"), family("e"), family("v", true)]);
const adapter = (changes: Partial<QueueCoordinatorAdapter> = {}): QueueCoordinatorAdapter => ({ reserve: async ({ family }) => ({ id: family.familyId, fence: "1" }), run: async () => ({ state: "verified", reason: "offline evidence checked" }), finish: async () => {}, ...changes });

test("runs five total items concurrently with independent verification inside the ceiling", async () => {
  let active = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const pending = executeQueueCoordinatorPlan(plan(), adapter({ run: async ({ family }) => {
    calls.push(family.familyId); active++; peak = Math.max(peak, active);
    if (active === 5) release();
    await gate; active--; return { state: "verified", reason: "evidence" };
  } }));
  const outcomes = await pending;
  assert.equal(peak, 5); assert.equal(new Set(calls).size, 5);
  assert.equal(outcomes.filter(x => x.role === "repair").length, 4);
  assert.equal(outcomes.filter(x => x.role === "verifier").length, 1);
});
test("stretch capacity cannot override the shared five-item ceiling", () => {
 assert.throws(()=>planQueueCoordinator([...Array.from({length:6},(_,i)=>family(`r${i}`)),family('v',true)],{repairLanes:7,maxItems:7,
  admission:{storageReady:true,providerReady:true,verifierReady:true,newItemLimit:7}}),/Total item capacity must be an integer between 1 and 5/u);
});
test('completion wakes a rolling plan only after finalization; refused or uncertain finalization does not free capacity',async()=>{
 let wakes=0,finished=false;
 await executeQueueCoordinatorPlan(planQueueCoordinator([family('a')]),adapter({finish:async()=>{finished=true;}}),{onSettled:()=>{assert.equal(finished,true);wakes++;}});assert.equal(wakes,1);
 await executeQueueCoordinatorPlan(planQueueCoordinator([family('b')]),adapter({reserve:async()=>null}),{onSettled:()=>wakes++});assert.equal(wakes,1);
 await executeQueueCoordinatorPlan(planQueueCoordinator([family('c')]),adapter({finish:async()=>{throw Error('uncertain');}}),{onSettled:()=>wakes++});assert.equal(wakes,1);
});

test('durable settlement can wake rolling capacity before slower post-finalization work completes',async()=>{
 const order:string[]=[];
 await executeQueueCoordinatorPlan(planQueueCoordinator([family('a')]),adapter({finish:async(_input,onDurablySettled)=>{
  order.push('durable');onDurablySettled?.();order.push('follow-up');
 }}),{onSettled:()=>order.push('wake')});
 assert.deepEqual(order,['durable','wake','follow-up']);
});

test('durable settlement notification is idempotent',async()=>{
 let wakes=0;
 await executeQueueCoordinatorPlan(planQueueCoordinator([family('a')]),adapter({finish:async(_input,onDurablySettled)=>{
  onDurablySettled?.();onDurablySettled?.();
 }}),{onSettled:()=>wakes++});
 assert.equal(wakes,1);
});

test("refused reservation cannot run or finish", async () => {
  let calls = 0;
  const outcomes = await executeQueueCoordinatorPlan(plan(), adapter({ reserve: async () => null, run: async () => { calls++; throw new Error(); }, finish: async () => { calls++; } }));
  assert.equal(calls, 0); assert.ok(outcomes.every(x => x.state === "suppressed"));
});

test("execution and finalization exceptions are uncertain with no retries", async () => {
  for (const failFinish of [false, true]) {
    let runs = 0, finishes = 0;
    const outcomes = await executeQueueCoordinatorPlan(planQueueCoordinator([family("a")]), adapter({ run: async () => { runs++; if (!failFinish) throw new Error("private error"); return { state: "verified", reason: "ok" }; }, finish: async input => { finishes++; if (failFinish) throw new Error("private error"); assert.equal(input.state, "uncertain"); } }));
    assert.equal(runs, 1); assert.equal(finishes, 1); assert.equal(outcomes[0].state, "uncertain");
    assert.ok(!outcomes[0].reason.includes("private error"));
  }
});

test("rejects duplicate family/lane and excess capacity before reservation", async () => {
  let calls = 0;
  const guarded = adapter({ reserve: async () => { calls++; return null; } });
  const p = plan();
  await assert.rejects(executeQueueCoordinatorPlan({ ...p, verifiers: [{ lane: 1, family: p.repairs[0].family }] }, guarded));
  await assert.rejects(executeQueueCoordinatorPlan({ ...p, repairs: [...p.repairs, p.repairs[0]] }, guarded));
  await assert.rejects(executeQueueCoordinatorPlan({ ...p, repairs: [p.repairs[0], { ...p.repairs[1], lane: 1 }] }, guarded));
  await assert.rejects(executeQueueCoordinatorPlan({...p,repairs:Array.from({length:8},(_,i)=>({lane:i+1,family:family(`extra-${i}`)}))},guarded));
  assert.equal(calls, 0);
});

test("uncertain diagnostics retain only safe machine codes, never raw payloads",async()=>{
  for(const code of ['42883','secret/path/token=private']){
    const [outcome]=await executeQueueCoordinatorPlan(planQueueCoordinator([family('a')]),adapter({run:async()=>{throw Object.assign(new Error('private payload'),{code});}}));
    assert.equal(outcome.state,'uncertain');
    assert.equal(outcome.reason.includes('42883'),code==='42883');
    assert.ok(!outcome.reason.includes('private'));
    assert.ok(!outcome.reason.includes('secret/path'));
  }
});
