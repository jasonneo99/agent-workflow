import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanRepositoryMaintenance, writeRepositoryMaintenanceReceipt } from "./index.js";

test("maintenance scan detects security material and writes a visible receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-"));
  await fs.mkdir(path.join(root, "apps"));
  await fs.writeFile(path.join(root, "apps", "x.ts"), 'const key = "AKIA1234567890123456";\n');
  const report = await scanRepositoryMaintenance(root);
  assert.equal(report.summary.security, 1);
  const receipt = await writeRepositoryMaintenanceReceipt(root, report, [{ file: "apps/x.ts", beforeHash: "a", afterHash: "b", validation: "passed" }]);
  assert.match(await fs.readFile(receipt, "utf8"), /beforeAfterHashes/u);
});
