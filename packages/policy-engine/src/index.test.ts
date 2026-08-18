import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { resolveExecutionPolicy } from "./index.js";

const project = projectConfigSchema.parse({
  project: {
    name: "Policy test",
    autonomy: "wide-open"
  },
  policies: {
    allow_wide_open: true,
    require_approval_for_external_actions: false,
    require_receipts: true
  },
  actions: {
    allowed_commands: ["npm test"],
    allowed_write_paths: ["src/**"]
  }
});

test("local policy preserves the configured project permissions", () => {
  const resolved = resolveExecutionPolicy(project, "local");
  assert.equal(resolved.project.project.autonomy, "wide-open");
  assert.equal(resolved.project.policies.allow_wide_open, true);
  assert.deepEqual(resolved.project.actions.allowed_write_paths, ["src/**"]);
});

test("staging policy caps autonomy and requires approvals and receipts", () => {
  const resolved = resolveExecutionPolicy(project, "staging");
  assert.equal(resolved.project.project.autonomy, 2);
  assert.equal(resolved.project.policies.allow_wide_open, false);
  assert.equal(resolved.project.policies.require_approval_for_external_actions, true);
  assert.equal(resolved.project.policies.require_receipts, true);
});

test("production policy is read-only", () => {
  const resolved = resolveExecutionPolicy(project, "production");
  assert.equal(resolved.project.project.autonomy, 1);
  assert.deepEqual(resolved.project.actions.allowed_commands, []);
  assert.deepEqual(resolved.project.actions.allowed_write_paths, []);
});

test("project-defined profiles override a built-in profile name", () => {
  const configured = projectConfigSchema.parse({
    ...project,
    execution: {
      policy_profile: "production",
      policy_profiles: {
        production: {
          autonomy: 0,
          policies: { require_receipts: true },
          actions: {}
        }
      }
    }
  });
  const resolved = resolveExecutionPolicy(configured);
  assert.equal(resolved.project.project.autonomy, 0);
  assert.deepEqual(resolved.project.actions.allowed_commands, ["npm test"]);
});

test("policy snapshots are stable and unknown profiles fail closed", () => {
  assert.equal(
    resolveExecutionPolicy(project, "production").snapshotHash,
    resolveExecutionPolicy(project, "production").snapshotHash
  );
  assert.throws(() => resolveExecutionPolicy(project, "missing"), /Unknown execution policy profile/);
});
