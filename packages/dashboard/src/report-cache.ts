import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const schemaVersion = 1;
const maxSnapshotBytes = 2_000_000;
const maxSnapshotAgeMs = 24 * 60 * 60 * 1000;
const durablePrefixes = ["model-improvement:", "server-readiness:"];

type DashboardReportSnapshot<T> = {
  schemaVersion: number;
  key: string;
  capturedAt: string;
  value: T;
};

export function isDurableDashboardReportKey(key: string): boolean {
  return durablePrefixes.some((prefix) => key.startsWith(prefix));
}

export function dashboardReportSnapshotPath(runtimeRoot: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(runtimeRoot, ".agent-workflow", "runtime", "dashboard-report-cache", `${digest}.json`);
}

export async function readDashboardReportSnapshot<T>(runtimeRoot: string, key: string, now = Date.now()): Promise<{ value: T; capturedAt: number } | null> {
  if (!isDurableDashboardReportKey(key)) return null;
  const target = dashboardReportSnapshotPath(runtimeRoot, key);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || stat.size > maxSnapshotBytes) return null;
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as DashboardReportSnapshot<T>;
  const capturedAt = Date.parse(parsed.capturedAt);
  if (
    parsed.schemaVersion !== schemaVersion ||
    parsed.key !== key ||
    !Number.isFinite(capturedAt) ||
    capturedAt > now + 60_000 ||
    now - capturedAt > maxSnapshotAgeMs
  ) return null;
  return { value: parsed.value, capturedAt };
}

export async function writeDashboardReportSnapshot<T>(runtimeRoot: string, key: string, value: T): Promise<boolean> {
  if (!isDurableDashboardReportKey(key)) return false;
  const target = dashboardReportSnapshotPath(runtimeRoot, key);
  const payload: DashboardReportSnapshot<T> = { schemaVersion, key, capturedAt: new Date().toISOString(), value };
  const serialized = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxSnapshotBytes) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  return true;
}
