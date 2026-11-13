import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { signWorkerHeartbeat, verifyWorkerHeartbeat, workerHostKeyFingerprint, workerRuntimeBuildDigest, type WorkerHeartbeatTrustStore } from "./worker-heartbeat-attestation.js";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const now = new Date("2026-10-26T20:00:00.000Z");
  const heartbeat: Record<string, unknown> = { workerId: "worker-a:1", lastHeartbeatAt: now.toISOString(), executionCapabilities: ["python-pycompile-glob-v1"] };
  const runtimeBuildDigest = workerRuntimeBuildDigest({ runtimeVersion: "0.4.7", bundleVersion: "1", protocolVersions: { runtime: 1 }, executionCapabilityProbes: [{ id: "python-pycompile-glob-v1", digest: "abc", runtimeVersion: "0.4.7", status: "passed" }] });
  const attestation = signWorkerHeartbeat({ heartbeat, hostId: "worker-a", privateKey, runtimeBuildDigest, sequence: "42", now });
  heartbeat.attestation = attestation;
  const trustStore: WorkerHeartbeatTrustStore = { schemaVersion: 1, hosts: [{ hostId: "worker-a", publicKey, keyFingerprint: workerHostKeyFingerprint(publicKey), allowedRuntimeBuildDigests: [runtimeBuildDigest] }] };
  return { heartbeat, trustStore, now, runtimeBuildDigest };
}

test("registered fleet host signs a fresh heartbeat bound to its runtime build", () => {
  const value = fixture();
  const result = verifyWorkerHeartbeat({ heartbeat: value.heartbeat, trustStore: value.trustStore, now: new Date(value.now.getTime() + 1_000) });
  assert.equal(result.trusted, true);
  assert.equal(result.state, "trusted-remote");
  assert.equal(result.hostId, "worker-a");
  assert.equal(result.runtimeBuildDigest, value.runtimeBuildDigest);
});

test("mutation, unknown hosts, disabled hosts and unapproved builds fail closed", () => {
  const mutated = fixture();
  mutated.heartbeat.workerId = "attacker";
  assert.equal(verifyWorkerHeartbeat({ heartbeat: mutated.heartbeat, trustStore: mutated.trustStore, now: mutated.now }).state, "invalid");
  const unknown = fixture();
  assert.equal(verifyWorkerHeartbeat({ heartbeat: unknown.heartbeat, trustStore: { schemaVersion: 1, hosts: [] }, now: unknown.now }).state, "unknown-host");
  const disabled = fixture();
  disabled.trustStore.hosts[0]!.enabled = false;
  assert.equal(verifyWorkerHeartbeat({ heartbeat: disabled.heartbeat, trustStore: disabled.trustStore, now: disabled.now }).state, "disabled-host");
  const wrongBuild = fixture();
  wrongBuild.trustStore.hosts[0]!.allowedRuntimeBuildDigests = ["different"];
  assert.equal(verifyWorkerHeartbeat({ heartbeat: wrongBuild.heartbeat, trustStore: wrongBuild.trustStore, now: wrongBuild.now }).state, "runtime-mismatch");
});

test("expired, future, replayed and unsigned remote heartbeats fail closed", () => {
  const expired = fixture();
  assert.equal(verifyWorkerHeartbeat({ heartbeat: expired.heartbeat, trustStore: expired.trustStore, now: new Date(expired.now.getTime() + 31_000) }).state, "expired");
  const future = fixture();
  assert.equal(verifyWorkerHeartbeat({ heartbeat: future.heartbeat, trustStore: future.trustStore, now: new Date(future.now.getTime() - 6_000) }).state, "future");
  const replayed = fixture();
  assert.equal(verifyWorkerHeartbeat({ heartbeat: replayed.heartbeat, trustStore: replayed.trustStore, now: replayed.now, latestSequenceByHost: new Map([["worker-a", "43"]]) }).state, "replayed");
  assert.equal(verifyWorkerHeartbeat({ heartbeat: { workerId: "remote" }, trustStore: replayed.trustStore, now: replayed.now }).state, "unsigned");
});
