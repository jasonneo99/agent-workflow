import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkStorageRegistry, environmentLine, routeLines, runtimeEnvLine } from "./lib/doctor-checks.js";
import type { ProjectConfig } from "../../../packages/agent-registry/src/schemas.js";

const fakeClient = (tables: boolean, ids: Array<{ kind: string; id: string }>) => ({
  query: async (sql: string) => sql.includes("to_regclass")
    ? { rows: [tables ? { agents: "agents", workflows: "workflows", runs: "workflow_runs" } : { agents: null, workflows: null, runs: null }] }
    : { rows: ids },
}) as never;

test("doctor reports unmigrated storage and unregistered definitions with the fix", async () => {
  assert.match((await checkStorageRegistry(fakeClient(false, []), ["a"], ["w"]))[0]!.message, /not migrated.*bootstrap-storage/);
  const missing = (await checkStorageRegistry(fakeClient(true, [{ kind: "agent", id: "a" }]), ["a"], ["w"]))[0]!;
  assert.equal(missing.status, "MISSING");
  assert.match(missing.message, /workflow w.*bootstrap-storage/);
  const ok = (await checkStorageRegistry(fakeClient(true, [{ kind: "agent", id: "a" }, { kind: "workflow", id: "w" }]), ["a"], ["w"]))[0]!;
  assert.equal(ok.status, "OK");
});

test("doctor warns when mock is requested but a tier routes live", () => {
  const routes = [{ tier: "fast", providerId: "mock" }, { tier: "standard", providerId: "codex-cli" }];
  assert.ok(routeLines(routes, "mock").some(line => line.status === "WARN" && /standard/.test(line.message)));
  assert.ok(routeLines(routes, "auto").every(line => line.status === "OK"));
});

test("doctor flags missing environment profiles and credentials in runtime.env by key only", async () => {
  assert.equal(environmentLine("/p", { execution: {} } as unknown as ProjectConfig).status, "WARN");
  assert.match(environmentLine("/p", { execution: { environments: { profiles: { node: {} } } } } as unknown as ProjectConfig).message, /1 environment profile declared/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-"));
  try {
    assert.equal((await runtimeEnvLine(root)).status, "OK");
    await fs.mkdir(path.join(root, ".agent-workflow"));
    await fs.writeFile(path.join(root, ".agent-workflow", "runtime.env"), "OPENAI_API_KEY=\nANTHROPIC_API_KEY=synthetic-value\n");
    const line = await runtimeEnvLine(root);
    assert.equal(line.status, "WARN");
    assert.match(line.message, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(line.message, /synthetic-value|OPENAI/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
