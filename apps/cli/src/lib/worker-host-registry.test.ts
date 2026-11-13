import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyWorkerHostRegistryPlan, buildWorkerHostRegistryPlan } from "./worker-host-registry.js";

const now=new Date("2026-10-26T20:00:00.000Z");
const publicKey=()=>generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString();

test("enrollment previews exact host key build policy and applies with immutable receipt",async()=>{
  const plan=buildWorkerHostRegistryPlan({store:{schemaVersion:1,hosts:[]},action:"enroll",hostId:"worker-a",publicKey:publicKey(),allowedRuntimeBuildDigests:["build-b","build-a"],expiresAt:"2027-01-01T00:00:00Z",now});
  assert.deepEqual(plan.allowedRuntimeBuildDigests,["build-a","build-b"]);assert.equal(plan.next.hosts[0]?.hostId,"worker-a");
  const dir=await mkdtemp(path.join(os.tmpdir(),"agentflow-host-registry-"));const registryPath=path.join(dir,"trusted.json");const receiptPath=path.join(dir,"receipts.jsonl");
  const receipt=await applyWorkerHostRegistryPlan({plan,registryPath,receiptPath,actor:"operator"});
  assert.equal(receipt.afterDigest,plan.afterDigest);assert.match(await readFile(receiptPath,"utf8"),/"actor":"operator"/);
  await assert.rejects(()=>applyWorkerHostRegistryPlan({plan,registryPath,receiptPath,actor:"operator"}),/changed after preview/);
});

test("rotation retains the old key only for the explicit overlap window",()=>{
  const first=buildWorkerHostRegistryPlan({store:{schemaVersion:1,hosts:[]},action:"enroll",hostId:"worker-a",publicKey:publicKey(),now});
  const rotated=buildWorkerHostRegistryPlan({store:first.next,action:"rotate",hostId:"worker-a",publicKey:publicKey(),overlapUntil:"2026-10-26T20:10:00Z",allowedRuntimeBuildDigests:["approved"],now});
  assert.equal(rotated.next.hosts.length,2);assert.equal(rotated.next.hosts.filter(host=>host.retiresAt).length,1);assert.equal(rotated.next.hosts.filter(host=>host.retiresAt===null).length,1);
});

test("disable revokes every key while self-registration and unbounded rotation fail closed",()=>{
  const enrolled=buildWorkerHostRegistryPlan({store:{schemaVersion:1,hosts:[]},action:"enroll",hostId:"worker-a",publicKey:publicKey(),now});
  const disabled=buildWorkerHostRegistryPlan({store:enrolled.next,action:"disable",hostId:"worker-a",now});
  assert.ok(disabled.next.hosts.every(host=>host.enabled===false));
  assert.throws(()=>buildWorkerHostRegistryPlan({store:{schemaVersion:1,hosts:[]},action:"enroll",hostId:"worker-a",now}),/operator-supplied public key/);
  assert.throws(()=>buildWorkerHostRegistryPlan({store:enrolled.next,action:"rotate",hostId:"worker-a",publicKey:publicKey(),now}),/overlapUntil/);
});
