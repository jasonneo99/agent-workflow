import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitRepositoryMaintenance, scanRepositoryMaintenance, writeRepositoryMaintenanceReceipt } from "./index.js";

const runFile = promisify(execFile);

test("maintenance scan detects security material and writes a visible receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-"));
  await fs.mkdir(path.join(root, "apps"));
  await fs.writeFile(path.join(root, "apps", "x.ts"), 'const key = "AKIA1234567890123456";\n');
  const report = await scanRepositoryMaintenance(root);
  assert.equal(report.summary.security, 1);
  const receipt = await writeRepositoryMaintenanceReceipt(root, report, [{ file: "apps/x.ts", beforeHash: "a", afterHash: "b", validation: "passed" }]);
  assert.match(await fs.readFile(receipt, "utf8"), /beforeAfterHashes/u);
});

test("maintenance commits stage only the exact validated files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-git-"));
  await runFile("git", ["init"], { cwd: root });
  await runFile("git", ["config", "user.email", "daemon@example.test"], { cwd: root });
  await runFile("git", ["config", "user.name", "Maintenance Daemon"], { cwd: root });
  await fs.writeFile(path.join(root, "owned.txt"), "before\n"); await fs.writeFile(path.join(root, "user.txt"), "before\n");
  await runFile("git", ["add", "."], { cwd: root }); await runFile("git", ["commit", "-m", "initial"], { cwd: root });
  await fs.writeFile(path.join(root, "owned.txt"), "after\n"); await fs.writeFile(path.join(root, "user.txt"), "user change\n");
  const result = await commitRepositoryMaintenance({ projectRoot: root, files: ["owned.txt"], validation: "test passed" });
  assert.ok(result?.hash);
  assert.match((await runFile("git", ["status", "--short"], { cwd: root })).stdout, /user\.txt/u);
});
// boundary-synthetic-fixtures: credential-shaped values below verify maintenance detection only.
