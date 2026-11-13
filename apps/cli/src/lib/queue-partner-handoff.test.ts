import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { partnerRecoveryOwnsNextStep, requestQueuePartnerHelp, type QueuePartnerHelpInput, type QueuePartnerHelpNotice } from "./queue-partner-handoff.js";
const projectId = "11111111-1111-4111-8111-111111111111";
const sourceRunId = "22222222-2222-4222-8222-222222222222";
const base: QueuePartnerHelpInput = { projectId, sourceRunId, familyId: `${projectId}:33333333-3333-4333-8333-333333333333`, failureFingerprint: "a".repeat(64), reasons: ["missing original acceptance contract", "missing exact original source scope"] };
test('Partner retains every recovery state, including code defects and missing observations',()=>{
  for(const state of ['waiting','eligible','enrolled','source-repaired','proposal']){
    assert.equal(partnerRecoveryOwnsNextStep({state,reason:'current bounded recovery'}),true,state);
  }
  assert.equal(partnerRecoveryOwnsNextStep({state:'held',reason:'Bounded evidence discovery pending next pass'}),true);
  for(const reason of ['Original receipt chain is not verified','Canonical root unavailable','Unsupported recovery transport']){
    assert.equal(partnerRecoveryOwnsNextStep({state:'held',reason}),true,reason);
  }
  assert.equal(partnerRecoveryOwnsNextStep({state:'failed',reason:'Partner coordinator code defect'}),true);
  assert.equal(partnerRecoveryOwnsNextStep(undefined),true);
  assert.equal(partnerRecoveryOwnsNextStep({state:'unknown',reason:'Bounded evidence discovery pending next pass'}),true);
});
test("old help callers never enqueue routine or framework code work, even after changed evidence", async () => {
  const notices: QueuePartnerHelpNotice[] = [];
  const adapter = { enqueue: async (notice: QueuePartnerHelpNotice) => { const reused = notices.some(existing => existing.eventKey === notice.eventKey); notices.push(notice); return { notificationId: "notice", reused }; } };
  const first = await requestQueuePartnerHelp(base, adapter);
  const second = await requestQueuePartnerHelp({ ...base, reasons: [...base.reasons].reverse().concat(base.reasons[0]) }, adapter);
  assert.equal(first.state, "suppressed"); assert.deepEqual(first, second);
  assert.match(first.reason, /Partner retains/); assert.match(first.reason, /approval gates remain enforced/);
  for(const reason of ['receipt chain missing','source scope unavailable','command-policy rejection','provider timeout',
    'terminal assignment needs reconciliation','Partner coordinator code defect','framework executor bug','independent verification failed']){
    const changed=await requestQueuePartnerHelp({...base,failureFingerprint:'b'.repeat(64),reasons:[reason]},adapter);
    assert.deepEqual(changed,first,reason);
  }
  assert.deepEqual(notices,[]);
});
test("permission, external, evaluation and ordinary scheduler waits never request technical help", async () => {
  let called = false; const adapter = { enqueue: async () => { called = true; return { notificationId: "notice", reused: false }; } };
  for (const input of [{ ...base, pendingApprovalIds: ["approval"] }, { ...base, evaluation: true }, { ...base, externalProofRequired: true },
    ...["pending approval", "family already active", "repair capacity", "overlapping execution scope", "evaluation or training has separate authorization", "native proof required", "credential required"].map(reason => ({ ...base, reasons: [...base.reasons, reason] }))]) {
    assert.equal((await requestQueuePartnerHelp(input, adapter)).state, "suppressed");
  }
  assert.equal(called, false);
});
test("invalid identity and unavailable trusted destination fail closed without arbitrary fallback", async () => {
  let called = false;
  assert.equal((await requestQueuePartnerHelp({ ...base, sourceRunId: "forged" }, { enqueue: async () => { called = true; return { notificationId: "notice", reused: false }; } })).state, "suppressed");
  assert.equal(called, false);
  assert.equal((await requestQueuePartnerHelp({ ...base, reasons: ["test ".repeat(1000)] }, { enqueue: async () => { called = true; return { notificationId: "notice", reused: false }; } })).state, "suppressed");
  assert.equal(called, false);
  assert.equal((await requestQueuePartnerHelp(base, { enqueue: async () => {throw Error('No transport may be opened');} })).state, "suppressed");
  assert.equal((await requestQueuePartnerHelp(base)).state, "suppressed",'Default compatibility path opens no storage or transport');
});
test("disabled handback never forwards private input to a transport or its response", async () => {
  let body = "";
  const result=await requestQueuePartnerHelp({ ...base, reasons: Array.from({ length: 12 }, (_, i) => `test ${i} failed token=private-value /Users/example/private https://private.example/secret\nsudo cat /etc/private\nsk-abcdefghijklmnop`) }, { enqueue: async notice => { body = notice.body; return { notificationId: "notice", reused: false }; } });
  assert.equal(body,'');
  assert.doesNotMatch(JSON.stringify(result), /private-value|\/Users\/example|private\.example|sudo cat|sk-abcdefghijklmnop/);
});
test("compatibility module has no notification, storage, command or workflow fallback", async () => {
  const source = await fs.readFile(new URL("./queue-partner-handoff.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /enqueueRunNotification|withClient|run_notifications|execFile|createWorkflowRun|deliverRunNotifications|approveAndExecute/);
});
