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

export interface BundleCompatibilityCheck {
  id: "agentWorkflow" | "node" | "mcp";
  label: string;
  required: string;
  actual: string;
  compatible: boolean;
  detail: string;
}

export interface BundleCompatibilityReport {
  bundleId: string;
  bundleVersion: string;
  compatible: boolean;
  checks: BundleCompatibilityCheck[];
  migrations: BundleManifest["migrations"];
}

export interface ProjectBundleState {
  schemaVersion: 1;
  bundle: {
    id: string;
    version: string;
    checksum: string;
    recordedAt?: string;
  };
}

export interface BundleUpgradePreview {
  bundleId: string;
  currentVersion: string;
  currentChecksum: string;
  source: {
    kind: "project-state" | "explicit" | "unknown";
    path?: string;
    bundleId?: string;
    version?: string;
    checksum?: string;
    recordedAt?: string;
  };
  status: "current" | "upgrade-available" | "unknown-source" | "different-bundle" | "checksum-drift";
  applicableMigrations: BundleManifest["migrations"];
  recommendations: string[];
}

export interface BundleRegistryEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  packageName?: string;
  homepage?: string;
  latestVersion: string;
  trustPolicy: BundleTrustPolicy;
  signerFingerprints: string[];
  install: {
    npm?: string;
    git?: string;
  };
  tags: string[];
  notes: string[];
}

export interface BundleRegistry {
  schemaVersion: 1;
  generatedAt?: string;
  entries: BundleRegistryEntry[];
}

export interface BundleRegistryReportEntry extends BundleRegistryEntry {
  selected: boolean;
  installedVersion: string | null;
  installedChecksum: string | null;
  status: "installed-current" | "upgrade-available" | "not-installed" | "different-bundle" | "checksum-drift";
  recommendations: string[];
}

export interface BundleRegistryReport {
  generatedAt: string;
  registryPath: string;
  installedBundleId: string | null;
  installedVersion: string | null;
  entries: BundleRegistryReportEntry[];
}

export interface ProjectBundlePin {
  schemaVersion: 1;
  bundle: {
    id: string;
    version: string;
    source: string;
    packageName?: string;
    checksum?: string;
    pinnedAt: string;
    pinnedBy: string;
    reason: string;
  };
}

export interface BundlePinPlan {
  projectDir: string;
  pinPath: string;
  status: "ready" | "unknown-bundle" | "version-mismatch";
  write: boolean;
  pin: ProjectBundlePin | null;
  warnings: string[];
  recommendations: string[];
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
      const manifestMatches = signature.bundleId === input.manifest.bundle.id && signature.bundleVersion === input.manifest.bundle.version && signature.manifestChecksum === input.manifest.checksum.value;
      if (!manifestMatches) {
        status = "unsigned";
        reasons.push("Detached bundle signature does not apply to this manifest.");
      } else if (fingerprint !== signature.signer.keyFingerprint) {
        status = "invalid";
        reasons.push("Signature signer fingerprint does not match the public key.");
      } else {
      const { signature: encodedSignature, ...unsigned } = signature;
      const valid = verify(null, Buffer.from(signaturePayload(input.manifest, unsigned)), signature.signer.publicKey, Buffer.from(encodedSignature, "base64"));
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
  const compatibility = buildBundleCompatibilityReport(committed, {
    agentWorkflow: runtimePackage.version ?? "0.0.0"
  });
  return verifyBundleSignature({
    manifest: committed,
    signature,
    trustStore: await readBundleTrustStore(),
    modified,
    compatible: compatibility.compatible,
    policy
  });
}

export function buildBundleCompatibilityReport(manifest: BundleManifest, actual?: { agentWorkflow?: string; node?: string; mcp?: string }): BundleCompatibilityReport {
  const checks: BundleCompatibilityCheck[] = [
    versionRangeCheck({
      id: "agentWorkflow",
      label: "Agent Workflow runtime",
      required: manifest.compatibility.agentWorkflow,
      actual: actual?.agentWorkflow ?? manifest.bundle.version
    }),
    versionRangeCheck({
      id: "node",
      label: "Node.js",
      required: manifest.compatibility.node,
      actual: actual?.node ?? process.version.slice(1)
    }),
    versionRangeCheck({
      id: "mcp",
      label: "MCP SDK",
      required: manifest.compatibility.mcp,
      actual: actual?.mcp ?? manifest.compatibility.mcp
    })
  ];
  return {
    bundleId: manifest.bundle.id,
    bundleVersion: manifest.bundle.version,
    compatible: checks.every((check) => check.compatible),
    checks,
    migrations: manifest.migrations
  };
}

export function formatBundleCompatibilityReport(report: BundleCompatibilityReport): string {
  return [
    `Bundle Compatibility: ${report.bundleId}@${report.bundleVersion}`,
    `Status: ${report.compatible ? "compatible" : "incompatible"}`,
    "Checks",
    ...report.checks.map((check) => `- ${check.compatible ? "PASS" : "FAIL"} ${check.label}: actual=${check.actual}, required=${check.required} (${check.detail})`),
    "Migration notes",
    ...(report.migrations.length
      ? report.migrations.map((migration) => `- ${migration.from} -> ${migration.to}: ${migration.notes.join(" ")}`)
      : ["- none"])
  ].join("\n");
}

export function buildBundleUpgradePreview(manifest: BundleManifest, input?: {
  state?: ProjectBundleState;
  statePath?: string;
  fromVersion?: string;
  fromChecksum?: string;
  fromBundleId?: string;
}): BundleUpgradePreview {
  const explicit = input?.fromVersion || input?.fromChecksum || input?.fromBundleId
    ? {
        kind: "explicit" as const,
        bundleId: input.fromBundleId ?? manifest.bundle.id,
        version: input.fromVersion,
        checksum: input.fromChecksum
      }
    : undefined;
  const source = explicit ?? (input?.state
    ? {
        kind: "project-state" as const,
        path: input.statePath,
        bundleId: input.state.bundle.id,
        version: input.state.bundle.version,
        checksum: input.state.bundle.checksum,
        recordedAt: input.state.bundle.recordedAt
      }
    : { kind: "unknown" as const });

  const sourceVersion = source.version;
  const sourceChecksum = source.checksum;
  const sourceBundleId = source.bundleId;
  let status: BundleUpgradePreview["status"] = "unknown-source";
  if (sourceBundleId && sourceBundleId !== manifest.bundle.id) {
    status = "different-bundle";
  } else if (sourceVersion && sourceVersion === manifest.bundle.version && sourceChecksum && sourceChecksum !== manifest.checksum.value) {
    status = "checksum-drift";
  } else if (sourceVersion && compareParsedVersions(sourceVersion, manifest.bundle.version) < 0) {
    status = "upgrade-available";
  } else if (sourceVersion && sourceVersion === manifest.bundle.version) {
    status = "current";
  }

  return {
    bundleId: manifest.bundle.id,
    currentVersion: manifest.bundle.version,
    currentChecksum: manifest.checksum.value,
    source,
    status,
    applicableMigrations: applicableMigrations(manifest, sourceVersion, status),
    recommendations: upgradeRecommendations(status)
  };
}

export function formatBundleUpgradePreview(preview: BundleUpgradePreview): string {
  return [
    `Bundle Upgrade Preview: ${preview.bundleId}@${preview.currentVersion}`,
    `Status: ${preview.status}`,
    `Current checksum: ${preview.currentChecksum}`,
    `Source: ${preview.source.kind}${preview.source.version ? ` ${preview.source.version}` : ""}${preview.source.path ? ` (${preview.source.path})` : ""}`,
    "Applicable migrations",
    ...(preview.applicableMigrations.length
      ? preview.applicableMigrations.map((migration) => `- ${migration.from} -> ${migration.to}: ${migration.notes.join(" ")}`)
      : ["- none"]),
    "Recommended actions",
    ...preview.recommendations.map((recommendation) => `- ${recommendation}`)
  ].join("\n");
}

export async function loadBundleRegistry(filePath: string): Promise<BundleRegistry> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as BundleRegistry;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid bundle registry: ${filePath}`);
  }
  return {
    schemaVersion: 1,
    generatedAt: parsed.generatedAt,
    entries: parsed.entries.map(normalizeRegistryEntry)
  };
}

export function buildBundleRegistryReport(input: {
  registry: BundleRegistry;
  registryPath: string;
  installedManifest?: BundleManifest | null;
  installedChecksum?: string | null;
}): BundleRegistryReport {
  const installedBundleId = input.installedManifest?.bundle.id ?? null;
  const installedVersion = input.installedManifest?.bundle.version ?? null;
  const installedChecksum = input.installedChecksum ?? input.installedManifest?.checksum.value ?? null;
  return {
    generatedAt: new Date().toISOString(),
    registryPath: input.registryPath,
    installedBundleId,
    installedVersion,
    entries: input.registry.entries.map((entry) => {
      const selected = entry.id === installedBundleId;
      const status = registryEntryStatus(entry, {
        selected,
        installedVersion,
        installedChecksum
      });
      return {
        ...entry,
        selected,
        installedVersion: selected ? installedVersion : null,
        installedChecksum: selected ? installedChecksum : null,
        status,
        recommendations: registryEntryRecommendations(entry, status)
      };
    })
  };
}

export function formatBundleRegistryReport(report: BundleRegistryReport): string {
  const lines = [
    `Bundle Registry: ${report.registryPath}`,
    `Installed: ${report.installedBundleId ?? "none"}${report.installedVersion ? `@${report.installedVersion}` : ""}`,
    "Bundles"
  ];
  for (const entry of report.entries) {
    lines.push(`- ${entry.id}@${entry.latestVersion}: ${entry.status}`);
    lines.push(`  Source: ${entry.source}`);
    if (entry.packageName) lines.push(`  Package: ${entry.packageName}`);
    for (const recommendation of entry.recommendations) lines.push(`  - ${recommendation}`);
  }
  return lines.join("\n");
}

export function buildBundlePinPlan(input: {
  registry: BundleRegistry;
  projectDir: string;
  bundleId: string;
  version?: string;
  checksum?: string;
  actor?: string;
  reason?: string;
  write?: boolean;
  now?: Date;
}): BundlePinPlan {
  const projectDir = path.resolve(input.projectDir);
  const pinPath = path.join(projectDir, ".agent-workflow", "bundle-pin.json");
  const entry = input.registry.entries.find((item) => item.id === input.bundleId);
  const requestedVersion = input.version ?? entry?.latestVersion;
  if (!entry || !requestedVersion) {
    return {
      projectDir,
      pinPath,
      status: "unknown-bundle",
      write: Boolean(input.write),
      pin: null,
      warnings: [`Bundle '${input.bundleId}' is not present in the selected registry.`],
      recommendations: ["Run bundle-registry to choose a known bundle id and version before pinning."]
    };
  }
  const status = requestedVersion === entry.latestVersion ? "ready" : "version-mismatch";
  const warnings = status === "version-mismatch"
    ? [`Requested version ${requestedVersion} differs from registry latest ${entry.latestVersion}.`]
    : [];
  return {
    projectDir,
    pinPath,
    status,
    write: Boolean(input.write),
    pin: {
      schemaVersion: 1,
      bundle: {
        id: entry.id,
        version: requestedVersion,
        source: entry.source,
        ...(entry.packageName ? { packageName: entry.packageName } : {}),
        ...(input.checksum ? { checksum: input.checksum } : {}),
        pinnedAt: (input.now ?? new Date()).toISOString(),
        pinnedBy: input.actor ?? "local-user",
        reason: input.reason ?? "Project-local bundle version pin."
      }
    },
    warnings,
    recommendations: [
      "Run bundle-verify and bundle-upgrade-preview before changing project adoption state.",
      "Commit bundle-pin.json with the project only after the team agrees on the pinned version.",
      "Use bundle-adopt separately after validating the installed bundle."
    ]
  };
}

export async function writeBundlePin(plan: BundlePinPlan): Promise<string> {
  if (!plan.pin) throw new Error("Cannot write a bundle pin without a pin plan.");
  await fs.mkdir(path.dirname(plan.pinPath), { recursive: true });
  await fs.writeFile(plan.pinPath, `${JSON.stringify(plan.pin, null, 2)}\n`, "utf8");
  return plan.pinPath;
}

export function formatBundlePinPlan(plan: BundlePinPlan): string {
  return [
    `Bundle Pin Plan: ${plan.status}`,
    `Project: ${plan.projectDir}`,
    `Pin file: ${plan.pinPath}`,
    `Mode: ${plan.write ? "write" : "dry-run"}`,
    plan.pin ? `Bundle: ${plan.pin.bundle.id}@${plan.pin.bundle.version}` : "Bundle: none",
    plan.pin?.bundle.packageName ? `Package: ${plan.pin.bundle.packageName}` : null,
    plan.pin?.bundle.source ? `Source: ${plan.pin.bundle.source}` : null,
    "Warnings",
    ...(plan.warnings.length ? plan.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "Recommended actions",
    ...plan.recommendations.map((recommendation) => `- ${recommendation}`)
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function normalizePolicy(value?: string): BundleTrustPolicy {
  return value === "warn" || value === "require" ? value : "allow";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function signaturePayload(manifest: BundleManifest, signature: Omit<BundleSignature, "signature">): string {
  return stableStringify({ manifest, signature });
}

function versionRangeCheck(input: { id: BundleCompatibilityCheck["id"]; label: string; required: string; actual: string }): BundleCompatibilityCheck {
  const actualVersion = parseVersion(input.actual);
  const minimum = input.required.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/)?.slice(1).map((part) => Number(part ?? 0));
  const maximum = input.required.match(/<\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/)?.slice(1).map((part) => Number(part ?? 0));
  const compatible = actualVersion
    ? (!minimum || compareVersions(actualVersion, toVersionTuple(minimum)) >= 0) &&
      (!maximum || compareVersions(actualVersion, toVersionTuple(maximum)) < 0)
    : false;
  return {
    ...input,
    compatible,
    detail: compatible ? "requirement satisfied" : "requirement not satisfied"
  };
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function toVersionTuple(parts: number[]): [number, number, number] {
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function compareParsedVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);
  return compareVersions(parsedA, parsedB);
}

function applicableMigrations(manifest: BundleManifest, fromVersion: string | undefined, status: BundleUpgradePreview["status"]): BundleManifest["migrations"] {
  if (!fromVersion || status === "unknown-source") return manifest.migrations;
  if (status !== "upgrade-available") return [];
  return manifest.migrations.filter((migration) => compareParsedVersions(migration.to, fromVersion) > 0 && compareParsedVersions(migration.to, manifest.bundle.version) <= 0);
}

function upgradeRecommendations(status: BundleUpgradePreview["status"]): string[] {
  switch (status) {
    case "current":
      return ["No bundle migration is required for this project state."];
    case "upgrade-available":
      return [
        "Review applicable migration notes before adopting the current bundle.",
        "Run bundle-compat and bundle-verify in the target environment.",
        "Run validate and workflow-graph previews before queueing write-capable workflows."
      ];
    case "checksum-drift":
      return [
        "The project records the same bundle version with a different checksum.",
        "Verify whether the shared bundle was modified without a version bump before adopting it."
      ];
    case "different-bundle":
      return [
        "The recorded project bundle id differs from this bundle.",
        "Treat this as a bundle replacement and review trust, compatibility, and migration notes manually."
      ];
    case "unknown-source":
      return [
        "No prior project bundle state was found or supplied.",
        "Treat this as a fresh adoption and review all migration notes plus bundle trust before use."
      ];
  }
}

function normalizeRegistryEntry(entry: BundleRegistryEntry): BundleRegistryEntry {
  return {
    id: String(entry.id),
    name: String(entry.name),
    description: String(entry.description),
    source: String(entry.source),
    packageName: entry.packageName ? String(entry.packageName) : undefined,
    homepage: entry.homepage ? String(entry.homepage) : undefined,
    latestVersion: String(entry.latestVersion),
    trustPolicy: normalizePolicy(entry.trustPolicy),
    signerFingerprints: Array.isArray(entry.signerFingerprints) ? entry.signerFingerprints.map(String) : [],
    install: {
      npm: entry.install?.npm ? String(entry.install.npm) : undefined,
      git: entry.install?.git ? String(entry.install.git) : undefined
    },
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    notes: Array.isArray(entry.notes) ? entry.notes.map(String) : []
  };
}

function registryEntryStatus(entry: BundleRegistryEntry, input: { selected: boolean; installedVersion: string | null; installedChecksum: string | null }): BundleRegistryReportEntry["status"] {
  if (!input.selected) return "not-installed";
  if (input.installedVersion && compareParsedVersions(input.installedVersion, entry.latestVersion) < 0) return "upgrade-available";
  if (input.installedVersion === entry.latestVersion) return "installed-current";
  return "checksum-drift";
}

function registryEntryRecommendations(entry: BundleRegistryEntry, status: BundleRegistryReportEntry["status"]): string[] {
  switch (status) {
    case "installed-current":
      return ["This bundle is current. Run bundle-verify when changing trust policy or signer keys."];
    case "upgrade-available":
      return ["Review bundle-upgrade-preview and definition-migrations before adopting the newer bundle.", "Run release or package manager upgrade commands only after trust verification passes."];
    case "not-installed":
      return [`Install with ${entry.install.npm ?? entry.install.git ?? "the registry source"} only if this bundle matches your project workflow policy.`];
    case "different-bundle":
      return ["Treat this as a bundle replacement and review trust, compatibility, and migration notes manually."];
    case "checksum-drift":
      return ["The installed bundle version does not match the registry latest version ordering. Verify source and checksum before adopting."];
  }
}
