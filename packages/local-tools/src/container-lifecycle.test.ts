import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runContainerLifecycle } from "./container-lifecycle.js";

async function fixture(compose: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-containers-"));
  await fs.mkdir(path.join(root, ".agent-workflow"));
  await fs.writeFile(path.join(root, "compose.yaml"), compose, "utf8");
  return root;
}

test("previews a bounded project-owned compose start", async (t) => {
  const root = await fixture("services:\n  api:\n    image: example/api:latest\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runContainerLifecycle({ projectRoot: root, action: "start", services: ["api"] });
  assert.equal(result.preview, true);
  assert.deepEqual(result.command.slice(-4), ["up", "--detach", "--remove-orphans", "api"]);
  assert.match(result.composeProject, /^agentflow-[a-f0-9]{12}$/u);
});

test("executes without a shell and records intent and result receipts", async (t) => {
  const root = await fixture("services:\n  db:\n    image: postgres:17\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const result = await runContainerLifecycle({
    projectRoot: root, action: "stop", execute: true, actor: "test",
    spawnCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); return { exitCode: 0, stdout: "ok", stderr: "" }; }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  const receipts = (await fs.readFile(result.receiptPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { phase: string; success: boolean | null });
  assert.deepEqual(receipts.map((receipt) => [receipt.phase, receipt.success]), [["intent", null], ["result", true]]);
});

for (const [label, compose, message] of [
  ["privileged mode", "services:\n  api:\n    image: x\n    privileged: true\n", /privileged mode/u],
  ["docker socket", "services:\n  api:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n", /engine socket/u],
  ["host root mount", "services:\n  api:\n    image: x\n    volumes:\n      - /:/host\n", /outside the project/u],
  ["relative mount escape", "services:\n  api:\n    image: x\n    volumes:\n      - ../private:/private\n", /outside the project/u],
  ["host network", "services:\n  api:\n    image: x\n    network_mode: host\n", /host network_mode/u],
  ["explicit container name", "services:\n  api:\n    image: x\n    container_name: shared-api\n", /container name/u],
  ["external build context", "services:\n  api:\n    build: ../private\n", /outside the project/u]
] as const) {
  test(`rejects ${label} before execution`, async (t) => {
    const root = await fixture(compose);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let called = false;
    await assert.rejects(runContainerLifecycle({ projectRoot: root, action: "start", execute: true,
      spawnCommand: async () => { called = true; return { exitCode: 0, stdout: "", stderr: "" }; } }), message);
    assert.equal(called, false);
  });
}

test("rejects unknown services and escaping compose paths", async (t) => {
  const root = await fixture("services:\n  api:\n    image: x\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(runContainerLifecycle({ projectRoot: root, action: "start", services: ["missing"] }), /unknown service/u);
  await assert.rejects(runContainerLifecycle({ projectRoot: root, composeFile: "../compose.yaml", action: "status" }), /escapes the project/u);
});

test("rejects a project-relative mount that follows a symlink outside the project", async (t) => {
  const root = await fixture("services:\n  api:\n    image: x\n    volumes:\n      - ./linked/private:/private\n");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-containers-outside-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.symlink(outside, path.join(root, "linked"));
  await assert.rejects(runContainerLifecycle({ projectRoot: root, action: "start" }), /follows a symlink outside/u);
});
