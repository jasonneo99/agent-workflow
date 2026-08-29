import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { BundleManifest } from "../../agent-registry/src/manifest.js";
import { buildBundleCompatibilityReport, buildBundleUpgradePreview, publicKeyFingerprint, signBundleManifest, verifyBundleSignature } from "./index.js";

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
