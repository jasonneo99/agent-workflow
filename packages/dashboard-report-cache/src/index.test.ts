import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dashboardReportSnapshotPath, isDurableDashboardReportKey, readDashboardReportSnapshot, writeDashboardReportSnapshot } from "./index.js";

test("dashboard report snapshots survive process-local cache loss", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-dashboard-cache-"));
  const key = "model-improvement:/project:50";
  assert.equal(await writeDashboardReportSnapshot(root, key, { status: "ready" }), true);
  assert.deepEqual((await readDashboardReportSnapshot<{ status: string }>(root, key))?.value, { status: "ready" });
  assert.equal(await writeDashboardReportSnapshot(root, "roadmap", { private: true }), false);
  assert.equal(isDurableDashboardReportKey("server-readiness:default"), true);
});

test("dashboard report snapshots reject stale and mismatched evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-dashboard-cache-"));
  const key = "server-readiness:default";
  await writeDashboardReportSnapshot(root, key, { status: "ready" });
  assert.equal(await readDashboardReportSnapshot(root, key, Date.now() + 25 * 60 * 60 * 1000), null);

  const target = new URL(`file://${dashboardReportSnapshotPath(root, key)}`);
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
  await fs.writeFile(target, `${JSON.stringify({ ...parsed, key: "server-readiness:other" })}\n`, "utf8");
  assert.equal(await readDashboardReportSnapshot(root, key), null);
});

test("dashboard report snapshots fail closed for oversized and future evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-dashboard-cache-"));
  const key = "model-improvement:/project:50";
  assert.equal(await writeDashboardReportSnapshot(root, key, { body: "x".repeat(2_000_000) }), false);
  assert.equal(await readDashboardReportSnapshot(root, key), null);

  await writeDashboardReportSnapshot(root, key, { status: "ready" });
  assert.equal(await readDashboardReportSnapshot(root, key, Date.now() - 120_000), null);
});
