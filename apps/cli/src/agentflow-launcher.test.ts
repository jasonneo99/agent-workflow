import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectLaunchEntry } from "../../../scripts/agentflow.mjs";

async function write(root: string, file: string, mtimeSeconds: number) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "");
  await fs.utimes(target, mtimeSeconds, mtimeSeconds);
}

test("launcher uses dist only when it is newer than every source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-launch-"));
  try {
    await write(root, "apps/cli/src/index.ts", 1_000);
    assert.equal(selectLaunchEntry(root, {}).mode, "tsx", "no build yet");
    await write(root, "dist/apps/cli/src/index.js", 2_000);
    await write(root, "packages/x/node_modules/dep/index.js", 9_000);
    assert.equal(selectLaunchEntry(root, {}).mode, "dist", "dependencies are not sources");
    assert.equal(selectLaunchEntry(root, { AGENTFLOW_LAUNCH: "tsx" }).mode, "tsx", "explicit opt-out");
    await write(root, "packages/x/src/schema.json", 3_000);
    const stale = selectLaunchEntry(root, {});
    assert.deepEqual(stale, { mode: "tsx", entry: path.join(root, "apps/cli/src/index.ts") }, "an edited source wins over a stale build");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("long-running supervisor children keep their tsx command lines", async () => {
  // dev-agentflow-stop identifies children by these command lines.
  const scripts = JSON.parse(await fs.readFile(new URL("../../../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  for (const name of ["agentflow", "dashboard", "worker", "worker:daemon", "learning:daemon"]) {
    assert.match(scripts[name]!, /^tsx apps\/cli\/src\/index\.ts/u, name);
  }
  assert.match(scripts.status!, /^node scripts\/agentflow\.mjs status$/u);
});
