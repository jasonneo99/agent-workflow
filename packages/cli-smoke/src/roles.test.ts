import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rootDir = process.cwd();

function runAgentflow(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], {
    cwd: rootDir,
    encoding: "utf8"
  });
}

function parseJsonOutput<T>(stdout: string): T {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `Expected JSON object in output:\n${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

test("roles report exposes JSON and export snapshots", { timeout: 60_000 }, async (t) => {
  const doctor = runAgentflow(["doctor"]);
  if (doctor.status !== 0) {
    t.skip("Agent Workflow storage services are not reachable for role audit smoke coverage.");
    return;
  }

  const json = runAgentflow(["roles", "--limit", "5", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const report = parseJsonOutput<{
    kind: string;
    generatedAt: string;
    filters: { status: string };
    projects: unknown[];
    decisionsByRole: unknown[];
    recentApprovals: unknown[];
  }>(json.stdout);

  assert.equal(report.kind, "agentflow_role_governance_report");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.filters.status, "all");
  assert.ok(Array.isArray(report.projects));
  assert.ok(Array.isArray(report.decisionsByRole));
  assert.ok(Array.isArray(report.recentApprovals));

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-role-audit-"));
  const exported = runAgentflow(["roles", "--limit", "5", "--export", "--out", outDir]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /Role audit snapshot written:/);
  assert.match(exported.stdout, /Markdown:/);
  assert.match(exported.stdout, /JSON:/);

  const files = await fs.readdir(outDir);
  const markdown = files.find((file) => file.endsWith(".md"));
  const exportedJson = files.find((file) => file.endsWith(".json"));
  assert.ok(markdown, "expected exported Markdown snapshot");
  assert.ok(exportedJson, "expected exported JSON snapshot");
  assert.match(await fs.readFile(path.join(outDir, markdown), "utf8"), /# Role Audit Snapshot/);
  const exportedReport = JSON.parse(await fs.readFile(path.join(outDir, exportedJson), "utf8")) as { kind: string };
  assert.equal(exportedReport.kind, "agentflow_role_governance_report");
});
