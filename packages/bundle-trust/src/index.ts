import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBundleManifest, compareBundleManifests, loadCommittedBundleManifest, type BundleManifest } from "../../agent-registry/src/manifest.js";

export type BundleTrustStatus = "trusted" | "valid-untrusted" | "unsigned" | "modified" | "expired" | "incompatible" | "invalid";
export type BundleTrustPolicy = "allow" | "warn" | "require";

export interface BundleSignature {
  schemaVersion: 1;
  algorithm: "ed25519";
  bundleId: string;
  bundleVersion: string;
  manifestChecksum: string;
  signedAt: string;
  expiresAt?: string;
  signer: { id: string; keyFingerprint: string; publicKey: string };
  signature: string;
}

export interface TrustedBundleKey {
  fingerprint: string;
  signerId: string;
  publicKey: string;
  trustedAt: string;
}

export interface BundleTrustStore {
  schemaVersion: 1;
  keys: TrustedBundleKey[];
}

export interface BundleVerification {
  status: BundleTrustStatus;
  trusted: boolean;
  bundleId: string;
  bundleVersion: string;
  manifestChecksum: string;
  signerId: string | null;
  keyFingerprint: string | null;
  signedAt: string | null;
  expiresAt: string | null;
  reasons: string[];
  policy: BundleTrustPolicy;
  allowed: boolean;
}

export function canonicalManifest(manifest: BundleManifest): string {
  return stableStringify(manifest);
}

export function publicKeyFingerprint(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function signBundleManifest(input: { manifest: BundleManifest; privateKey: string; signerId: string; expiresAt?: string; signedAt?: string }): BundleSignature {
  const privateKey = createPrivateKey(input.privateKey);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const unsigned: Omit<BundleSignature, "signature"> = {
    schemaVersion: 1,
    algorithm: "ed25519",
    bundleId: input.manifest.bundle.id,
    bundleVersion: input.manifest.bundle.version,
    manifestChecksum: input.manifest.checksum.value,
    signedAt: input.signedAt ?? new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    signer: { id: input.signerId, keyFingerprint: publicKeyFingerprint(publicKey), publicKey }
  };
  return { ...unsigned, signature: sign(null, Buffer.from(signaturePayload(input.manifest, unsigned)), privateKey).toString("base64") };
}

export function verifyBundleSignature(input: {
  manifest: BundleManifest;
  signature?: BundleSignature;
  trustStore?: BundleTrustStore;
  modified?: boolean;
  compatible?: boolean;
  policy?: BundleTrustPolicy;
  now?: Date;
}): BundleVerification {
  const policy = input.policy ?? "allow";
  const base = {
    bundleId: input.manifest.bundle.id,
    bundleVersion: input.manifest.bundle.version,
    manifestChecksum: input.manifest.checksum.value,
    policy
  };
  let status: BundleTrustStatus;
  const reasons: string[] = [];
  const signature = input.signature;
  if (input.modified) {
    status = "modified";
    reasons.push("Bundle files do not match the committed manifest.");
  } else if (!input.compatible) {
    status = "incompatible";
    reasons.push("Bundle compatibility requirements are not satisfied.");
  } else if (!signature) {
    status = "unsigned";
    reasons.push("No detached bundle signature was found.");
  } else {
    try {
      const fingerprint = publicKeyFingerprint(signature.signer.publicKey);
      const metadataMatches = signature.bundleId === input.manifest.bundle.id && signature.bundleVersion === input.manifest.bundle.version && signature.manifestChecksum === input.manifest.checksum.value && fingerprint === signature.signer.keyFingerprint;
      const { signature: encodedSignature, ...unsigned } = signature;
      const valid = metadataMatches && verify(null, Buffer.from(signaturePayload(input.manifest, unsigned)), signature.signer.publicKey, Buffer.from(encodedSignature, "base64"));
      if (!valid) {
        status = "invalid";
        reasons.push("Signature or signed manifest metadata is invalid.");
      } else if (signature.expiresAt && Date.parse(signature.expiresAt) <= (input.now ?? new Date()).getTime()) {
        status = "expired";
        reasons.push(`Signature expired at ${signature.expiresAt}.`);
      } else {
        const trusted = input.trustStore?.keys.some((key) => key.fingerprint === fingerprint && publicKeyFingerprint(key.publicKey) === fingerprint) ?? false;
        status = trusted ? "trusted" : "valid-untrusted";
        reasons.push(trusted ? "Signature is valid and the signer is trusted." : "Signature is valid but the signer is not in the trust store.");
      }
    } catch (error) {
      status = "invalid";
      reasons.push(`Signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const trusted = status === "trusted";
  const allowed = policy === "allow" ? !["modified", "invalid", "incompatible"].includes(status) : policy === "warn" ? !["modified", "invalid", "incompatible"].includes(status) : trusted;
  return {
    ...base,
    status,
    trusted,
    signerId: signature?.signer.id ?? null,
    keyFingerprint: signature?.signer.keyFingerprint ?? null,
    signedAt: signature?.signedAt ?? null,
    expiresAt: signature?.expiresAt ?? null,
    reasons,
    allowed
  };
}

export function bundleTrustStorePath(): string {
  return process.env.AGENTFLOW_BUNDLE_TRUST_STORE ?? path.join(os.homedir(), ".config", "agent-workflow", "trusted-bundle-keys.json");
}

export async function readBundleTrustStore(filePath = bundleTrustStorePath()): Promise<BundleTrustStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as BundleTrustStore;
    return parsed.schemaVersion === 1 && Array.isArray(parsed.keys) ? parsed : { schemaVersion: 1, keys: [] };
  } catch {
    return { schemaVersion: 1, keys: [] };
  }
}

export async function writeBundleTrustStore(store: BundleTrustStore, filePath = bundleTrustStorePath()): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function verifyBundle(rootDir: string, policy: BundleTrustPolicy = normalizePolicy(process.env.AGENTFLOW_BUNDLE_TRUST_POLICY)): Promise<BundleVerification> {
  const committed = await loadCommittedBundleManifest(rootDir);
  if (!committed) throw new Error("Bundle manifest is missing.");
  const actual = await buildBundleManifest(rootDir);
  const modified = compareBundleManifests(committed, actual).length > 0;
  let signature: BundleSignature | undefined;
  try { signature = JSON.parse(await fs.readFile(path.join(rootDir, "agent-workflow.bundle.sig.json"), "utf8")) as BundleSignature; } catch {}
  const runtimePackage = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")) as { version?: string };
  return verifyBundleSignature({
    manifest: committed,
    signature,
    trustStore: await readBundleTrustStore(),
    modified,
    compatible: bundleCompatible(committed, runtimePackage.version ?? "0.0.0"),
    policy
  });
}

export function normalizePolicy(value?: string): BundleTrustPolicy {
  return value === "warn" || value === "require" ? value : "allow";
}

function bundleCompatible(manifest: BundleManifest, runtimeVersion: string): boolean {
  const nodeMinimum = Number(manifest.compatibility.node.match(/>=\s*(\d+)/)?.[1] ?? 0);
  const currentMajor = Number(process.version.slice(1).split(".")[0] ?? 0);
  const runtime = runtimeVersion.split(".").map(Number);
  const minimum = manifest.compatibility.agentWorkflow.match(/>=\s*(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const maximumMajor = Number(manifest.compatibility.agentWorkflow.match(/<\s*(\d+)\./)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const atLeastMinimum = !minimum || runtime[0] > minimum[0] || runtime[0] === minimum[0] && (runtime[1] > minimum[1] || runtime[1] === minimum[1] && runtime[2] >= minimum[2]);
  return currentMajor >= nodeMinimum && atLeastMinimum && runtime[0] < maximumMajor;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function signaturePayload(manifest: BundleManifest, signature: Omit<BundleSignature, "signature">): string {
  return stableStringify({ manifest, signature });
}
