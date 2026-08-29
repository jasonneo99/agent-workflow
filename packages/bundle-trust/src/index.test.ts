import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { BundleManifest } from "../../agent-registry/src/manifest.js";
import { buildBundleCompatibilityReport, buildBundlePinPlan, buildBundleRegistryReport, buildBundleUpgradePreview, publicKeyFingerprint, signBundleManifest, verifyBundleSignature } from "./index.js";

const manifest = { schemaVersion: 1, bundle: { id: "bundle", name: "Bundle", version: "0.1.0", source: "test", description: "test" }, compatibility: { agentWorkflow: ">=0.1.0 <1.0.0", node: ">=24", mcp: ">=1.29.0" }, counts: { agents: 0, workflows: 0, files: 0 }, checksum: { algorithm: "sha256", value: "abc" }, agents: [], workflows: [], files: [], migrations: [] } satisfies BundleManifest;
const migrationManifest = {
  ...manifest,
  bundle: { ...manifest.bundle, version: "0.3.0" },
  migrations: [
    { from: "0.1.x", to: "0.2.0", notes: ["Review project policy profiles."] },
    { from: "0.2.x", to: "0.3.0", notes: ["Review workflow stage ids."] }
  ]
} satisfies BundleManifest;

test("valid signatures distinguish trusted and unknown signers", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signature = signBundleManifest({ manifest, privateKey: privatePem, signerId: "release" });
  assert.equal(verifyBundleSignature({ manifest, signature, compatible: true }).status, "valid-untrusted");
  const trusted = verifyBundleSignature({ manifest, signature, compatible: true, policy: "require", trustStore: { schemaVersion: 1, keys: [{ fingerprint: publicKeyFingerprint(publicPem), signerId: "release", publicKey: publicPem, trustedAt: new Date().toISOString() }] } });
  assert.equal(trusted.status, "trusted");
  assert.equal(trusted.allowed, true);
});

test("required trust rejects unsigned and modified bundles", () => {
  assert.equal(verifyBundleSignature({ manifest, compatible: true, policy: "require" }).allowed, false);
  assert.equal(verifyBundleSignature({ manifest, compatible: true, modified: true }).status, "modified");
});

test("signed metadata tampering invalidates the signature", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signature = signBundleManifest({ manifest, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), signerId: "release", expiresAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(verifyBundleSignature({ manifest, signature: { ...signature, expiresAt: "2040-01-01T00:00:00.000Z" }, compatible: true }).status, "invalid");
  assert.equal(verifyBundleSignature({ manifest, signature, compatible: true, now: new Date("2040-01-01T00:00:00.000Z") }).status, "expired");
});

test("stale detached signatures are treated as unsigned", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signature = signBundleManifest({ manifest, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), signerId: "release" });
  const changedManifest = { ...manifest, checksum: { ...manifest.checksum, value: "changed" } } satisfies BundleManifest;
  const allowed = verifyBundleSignature({ manifest: changedManifest, signature, compatible: true, policy: "allow" });
  const required = verifyBundleSignature({ manifest: changedManifest, signature, compatible: true, policy: "require" });
  assert.equal(allowed.status, "unsigned");
  assert.equal(allowed.allowed, true);
  assert.equal(required.status, "unsigned");
  assert.equal(required.allowed, false);
});

test("bundle compatibility report passes supported runtime requirements", () => {
  const report = buildBundleCompatibilityReport(manifest, {
    agentWorkflow: "0.2.1",
    node: "26.3.0",
    mcp: "1.29.0"
  });
  assert.equal(report.compatible, true);
  assert.deepEqual(report.checks.map((check) => check.compatible), [true, true, true]);
});

test("bundle compatibility report fails unsupported runtime requirements", () => {
  const report = buildBundleCompatibilityReport(manifest, {
    agentWorkflow: "1.0.0",
    node: "22.0.0",
    mcp: "1.28.0"
  });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.checks.map((check) => check.compatible), [false, false, false]);
});

test("bundle upgrade preview reports current project state", () => {
  const preview = buildBundleUpgradePreview(manifest, {
    state: { schemaVersion: 1, bundle: { id: "bundle", version: "0.1.0", checksum: "abc" } }
  });
  assert.equal(preview.status, "current");
  assert.equal(preview.applicableMigrations.length, 0);
});

test("bundle upgrade preview reports applicable migrations", () => {
  const preview = buildBundleUpgradePreview(migrationManifest, {
    fromVersion: "0.1.0",
    fromChecksum: "old"
  });
  assert.equal(preview.status, "upgrade-available");
  assert.deepEqual(preview.applicableMigrations.map((migration) => migration.to), ["0.2.0", "0.3.0"]);
});

test("bundle upgrade preview reports unknown source and checksum drift", () => {
  const unknown = buildBundleUpgradePreview(manifest);
  assert.equal(unknown.status, "unknown-source");
  assert.equal(unknown.applicableMigrations.length, manifest.migrations.length);

  const drift = buildBundleUpgradePreview(manifest, {
    state: { schemaVersion: 1, bundle: { id: "bundle", version: "0.1.0", checksum: "changed" } }
  });
  assert.equal(drift.status, "checksum-drift");
});

test("bundle registry report marks the installed bundle current or upgradeable", () => {
  const registry = {
    schemaVersion: 1 as const,
    entries: [
      {
        id: "bundle",
        name: "Bundle",
        description: "test",
        source: "https://example.com/bundle.git",
        packageName: "@example/bundle",
        latestVersion: "0.1.0",
        trustPolicy: "warn" as const,
        signerFingerprints: ["abc"],
        install: { npm: "npm install -g @example/bundle" },
        tags: ["test"],
        notes: ["note"]
      }
    ]
  };
  const current = buildBundleRegistryReport({
    registry,
    registryPath: "registries/bundles.json",
    installedManifest: manifest
  });
  assert.equal(current.entries[0].selected, true);
  assert.equal(current.entries[0].status, "installed-current");

  const upgradeable = buildBundleRegistryReport({
    registry: { ...registry, entries: [{ ...registry.entries[0], latestVersion: "0.2.0" }] },
    registryPath: "registries/bundles.json",
    installedManifest: manifest
  });
  assert.equal(upgradeable.entries[0].status, "upgrade-available");
});

test("bundle registry report lists uninstalled bundles without selecting them", () => {
  const report = buildBundleRegistryReport({
    registry: {
      schemaVersion: 1,
      entries: [
        {
          id: "other",
          name: "Other",
          description: "test",
          source: "https://example.com/other.git",
          latestVersion: "0.1.0",
          trustPolicy: "require",
          signerFingerprints: [],
          install: { git: "git clone https://example.com/other.git" },
          tags: [],
          notes: []
        }
      ]
    },
    registryPath: "registries/bundles.json",
    installedManifest: manifest
  });
  assert.equal(report.entries[0].selected, false);
  assert.equal(report.entries[0].status, "not-installed");
  assert.equal(report.entries[0].installedVersion, null);
});

test("bundle pin plan prepares project-local pin metadata", () => {
  const plan = buildBundlePinPlan({
    registry: {
      schemaVersion: 1,
      entries: [
        {
          id: "bundle",
          name: "Bundle",
          description: "test",
          source: "https://example.com/bundle.git",
          packageName: "@example/bundle",
          latestVersion: "0.2.0",
          trustPolicy: "warn",
          signerFingerprints: [],
          install: {},
          tags: [],
          notes: []
        }
      ]
    },
    projectDir: "/tmp/example",
    bundleId: "bundle",
    actor: "tester",
    reason: "Pin for tests.",
    now: new Date("2026-08-29T00:00:00.000Z")
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.write, false);
  assert.equal(plan.pin?.bundle.version, "0.2.0");
  assert.equal(plan.pin?.bundle.pinnedBy, "tester");
  assert.equal(plan.pin?.bundle.reason, "Pin for tests.");
});

test("bundle pin plan warns on unknown bundles and version mismatches", () => {
  const registry = {
    schemaVersion: 1 as const,
    entries: [
      {
        id: "bundle",
        name: "Bundle",
        description: "test",
        source: "https://example.com/bundle.git",
        latestVersion: "0.2.0",
        trustPolicy: "warn" as const,
        signerFingerprints: [],
        install: {},
        tags: [],
        notes: []
      }
    ]
  };
  assert.equal(buildBundlePinPlan({ registry, projectDir: "/tmp/example", bundleId: "missing" }).status, "unknown-bundle");
  const mismatch = buildBundlePinPlan({ registry, projectDir: "/tmp/example", bundleId: "bundle", version: "0.1.0" });
  assert.equal(mismatch.status, "version-mismatch");
  assert.equal(mismatch.warnings.length, 1);
});
