import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { resolveLocalProjectRootUri } from "./builders-shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("a Mac-registered root loads this host's checkout config through the path map", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aw-queue-root-"));
  const previous = process.env.AGENTFLOW_PROJECT_PATH_MAP;
  try {
    const checkout = path.join(dir, "agent-workflow");
    await mkdir(path.join(checkout, ".agent-workflow"), { recursive: true });
    await writeFile(path.join(checkout, ".agent-workflow", "project.yaml"), "project:\n  name: example-config\n");
    const registered = "/nonexistent/agentflow-fixture/registered/Agent Workflow";
    process.env.AGENTFLOW_PROJECT_PATH_MAP = `${registered}=${checkout}`;
    await assert.rejects(loadProjectConfig(registered), /ENOENT/);
    const local = await resolveLocalProjectRootUri(registered);
    assert.equal(local, checkout);
    assert.equal((await loadProjectConfig(local)).project.name, "example-config");
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_PROJECT_PATH_MAP;
    else process.env.AGENTFLOW_PROJECT_PATH_MAP = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("queueing and conversations read config and agents from the mapped root", async () => {
  const source = await readFile(path.join(here, "builders-server.ts"), "utf8");
  for (const registered of ["routePreview.route.projectRootUri", "resolution.project.rootUri"]) {
    assert.ok(!source.includes(`loadProjectConfig(${registered})`), `unmapped loadProjectConfig(${registered})`);
    assert.ok(!source.includes(`loadAgentsForProject(ctx, ${registered})`), `unmapped loadAgentsForProject(${registered})`);
    assert.ok(source.includes(`resolveLocalProjectRootUri(${registered})`));
  }
});

test("the queued workflow runs from the mapped checkout under its registered root", async () => {
  const source = await readFile(path.join(here, "builders-server.ts"), "utf8");
  // queueWorkflow loads project config and agents from projectPath, so an
  // unmapped Mac root failed every non-adaptive queue request with ENOENT.
  assert.ok(!source.includes("projectPath: routePreview.route.projectRootUri"),
    "queueWorkflow must not receive the unmapped registered root");
  assert.match(source, /projectPath: localProjectRoot,\s*registeredProjectRootUri: routePreview\.route\.projectRootUri,/u);
});
