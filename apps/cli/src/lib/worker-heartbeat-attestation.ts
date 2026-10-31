import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export type WorkerHeartbeatAttestation = {
  schemaVersion: 1;
  hostId: string;
  keyFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  sequence: string;
  runtimeBuildDigest: string;
  payloadDigest: string;
  signature: string;
};

export type TrustedWorkerHost = {
  hostId: string;
  publicKey: string;
  keyFingerprint: string;
  enabled?: boolean;
  registeredAt?: string;
  expiresAt?: string | null;
  retiresAt?: string | null;
  allowedRuntimeBuildDigests?: string[];
};

export type WorkerHeartbeatTrustStore = {
  schemaVersion: 1;
  hosts: TrustedWorkerHost[];
};

export type WorkerHeartbeatTrustDecision = {
  trusted: boolean;
  state: "trusted-remote" | "unsigned" | "unknown-host" | "disabled-host" | "invalid" | "expired" | "future" | "replayed" | "runtime-mismatch";
  reason: string;
  hostId: string | null;
  runtimeBuildDigest: string | null;
  sequence: string | null;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function heartbeatPayload(heartbeat: Record<string, unknown>): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(heartbeat)) {
    if (key !== "attestation") payload[key] = value as JsonValue;
  }
  return payload;
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function workerHeartbeatPayloadDigest(heartbeat: Record<string, unknown>): string {
  return digest(heartbeatPayload(heartbeat));
}

export function workerRuntimeBuildDigest(input: {
  runtimeVersion: string;
  bundleVersion: string;
  protocolVersions: Record<string, unknown>;
  executionCapabilityProbes: Array<{ id: string; digest: string; runtimeVersion: string; status: string }>;
}): string {
  return digest({
    runtimeVersion: input.runtimeVersion,
    bundleVersion: input.bundleVersion,
    protocolVersions: input.protocolVersions as JsonValue,
    executionCapabilityProbes: [...input.executionCapabilityProbes]
      .map((probe) => ({ id: probe.id, digest: probe.digest, runtimeVersion: probe.runtimeVersion, status: probe.status }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });
}

export function workerHostKeyFingerprint(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function signedAttestationPayload(attestation: Omit<WorkerHeartbeatAttestation, "signature">): string {
  return canonicalJson(attestation as unknown as JsonValue);
}

export function signWorkerHeartbeat(input: {
  heartbeat: Record<string, unknown>;
  hostId: string;
  privateKey: string;
  runtimeBuildDigest: string;
  sequence: string;
  now?: Date;
  ttlMs?: number;
}): WorkerHeartbeatAttestation {
  const now = input.now ?? new Date();
  const ttlMs = Math.min(60_000, Math.max(5_000, input.ttlMs ?? 30_000));
  const privateKey = createPrivateKey(input.privateKey);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const unsigned: Omit<WorkerHeartbeatAttestation, "signature"> = {
    schemaVersion: 1,
    hostId: input.hostId,
    keyFingerprint: workerHostKeyFingerprint(publicKey),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    sequence: input.sequence,
    runtimeBuildDigest: input.runtimeBuildDigest,
    payloadDigest: workerHeartbeatPayloadDigest(input.heartbeat)
  };
  return { ...unsigned, signature: sign(null, Buffer.from(signedAttestationPayload(unsigned)), privateKey).toString("base64") };
}

function decision(state: WorkerHeartbeatTrustDecision["state"], reason: string, attestation?: Partial<WorkerHeartbeatAttestation>): WorkerHeartbeatTrustDecision {
  return {
    trusted: state === "trusted-remote",
    state,
    reason,
    hostId: typeof attestation?.hostId === "string" ? attestation.hostId : null,
    runtimeBuildDigest: typeof attestation?.runtimeBuildDigest === "string" ? attestation.runtimeBuildDigest : null,
    sequence: typeof attestation?.sequence === "string" ? attestation.sequence : null
  };
}

export function verifyWorkerHeartbeat(input: {
  heartbeat: Record<string, unknown>;
  trustStore: WorkerHeartbeatTrustStore;
  now?: Date;
  maxFutureSkewMs?: number;
  latestSequenceByHost?: ReadonlyMap<string, string>;
}): WorkerHeartbeatTrustDecision {
  const raw = input.heartbeat.attestation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return decision("unsigned", "Remote heartbeat has no signed host attestation.");
  const attestation = raw as Partial<WorkerHeartbeatAttestation>;
  if (attestation.schemaVersion !== 1 || typeof attestation.hostId !== "string" || typeof attestation.keyFingerprint !== "string" || typeof attestation.issuedAt !== "string" || typeof attestation.expiresAt !== "string" || typeof attestation.sequence !== "string" || typeof attestation.runtimeBuildDigest !== "string" || typeof attestation.payloadDigest !== "string" || typeof attestation.signature !== "string") {
    return decision("invalid", "Remote heartbeat attestation is malformed.", attestation);
  }
  const host = input.trustStore.hosts.find((candidate) => candidate.hostId === attestation.hostId && candidate.keyFingerprint === attestation.keyFingerprint);
  if (!host) return decision("unknown-host", "Heartbeat signer is not a registered fleet host.", attestation);
  if (host.enabled === false) return decision("disabled-host", "Heartbeat signer is disabled in the fleet host registry.", attestation);
  let fingerprint: string;
  try { fingerprint = workerHostKeyFingerprint(host.publicKey); } catch { return decision("invalid", "Registered fleet host public key is invalid.", attestation); }
  if (fingerprint !== host.keyFingerprint) return decision("invalid", "Registered fleet host key fingerprint does not match its public key.", attestation);
  const now = (input.now ?? new Date()).getTime();
  const hostExpiresAt=host.expiresAt?Date.parse(host.expiresAt):Number.POSITIVE_INFINITY;
  const hostRetiresAt=host.retiresAt?Date.parse(host.retiresAt):Number.POSITIVE_INFINITY;
  if((host.expiresAt&&!Number.isFinite(hostExpiresAt))||(host.retiresAt&&!Number.isFinite(hostRetiresAt)))return decision("invalid","Registered fleet host key has an invalid lifecycle timestamp.",attestation);
  if(hostExpiresAt<=now||hostRetiresAt<=now)return decision("expired","Registered fleet host key is expired or retired.",attestation);
  const issuedAt = Date.parse(attestation.issuedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return decision("invalid", "Heartbeat attestation has an invalid validity window.", attestation);
  if (issuedAt > now + (input.maxFutureSkewMs ?? 5_000)) return decision("future", "Heartbeat attestation was issued too far in the future.", attestation);
  if (expiresAt <= now) return decision("expired", "Heartbeat attestation has expired.", attestation);
  const previousSequence = input.latestSequenceByHost?.get(attestation.hostId);
  try {
    if (previousSequence !== undefined && BigInt(attestation.sequence) < BigInt(previousSequence)) return decision("replayed", "Heartbeat sequence is older than the accepted host sequence.", attestation);
  } catch {
    return decision("invalid", "Heartbeat sequence is not an integer.", attestation);
  }
  if (host.allowedRuntimeBuildDigests?.length && !host.allowedRuntimeBuildDigests.includes(attestation.runtimeBuildDigest)) return decision("runtime-mismatch", "Heartbeat runtime build digest is not allowed for this fleet host.", attestation);
  if (workerHeartbeatPayloadDigest(input.heartbeat) !== attestation.payloadDigest) return decision("invalid", "Heartbeat payload changed after it was signed.", attestation);
  const { signature, ...unsigned } = attestation as WorkerHeartbeatAttestation;
  try {
    if (!verify(null, Buffer.from(signedAttestationPayload(unsigned)), host.publicKey, Buffer.from(signature, "base64"))) return decision("invalid", "Heartbeat signature verification failed.", attestation);
  } catch {
    return decision("invalid", "Heartbeat signature verification failed.", attestation);
  }
  return decision("trusted-remote", "Heartbeat signature, host registration, freshness, sequence, and runtime build digest are valid.", attestation);
}
