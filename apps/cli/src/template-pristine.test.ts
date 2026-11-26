import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureProjectNameFromFolder } from "./lib/builders-project.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("project templates track only manifest files, so smoke-test residue cannot ship", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "templates", "template-manifest.json"), "utf8")) as Record<string, string[]>;
  for (const [name, entries] of Object.entries(manifest)) {
    const tracked = execFileSync("git", ["ls-files", `templates/${name}`], { cwd: root, encoding: "utf8" })
      .split("\n").filter(Boolean).map((file) => file.slice(`templates/${name}/`.length));
    if (!tracked.length) continue;
    assert.deepEqual(tracked.filter((file) => !entries.includes(file)), [], `templates/${name} tracks files outside its manifest`);
  }
});

test("template decisions start empty", async () => {
  for (const name of ["project", "project-simple"]) {
    const decisions = await fs.readFile(path.join(root, "templates", name, ".agent-workflow", "decisions.md"), "utf8");
    assert.doesNotMatch(decisions, /^### \d{4}-\d{2}-\d{2}:/mu, `templates/${name} decisions.md contains a recorded decision`);
  }
});

test("init names the project after its folder instead of the template placeholder", async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-name-")), "billing-api");
  await fs.mkdir(path.join(dir, ".agent-workflow"), { recursive: true });
  await fs.writeFile(path.join(dir, ".agent-workflow", "project.yaml"), "project:\n  name: Example Project\n  autonomy: 3\n");
  assert.equal(await ensureProjectNameFromFolder(dir), "billing-api");
  assert.match(await fs.readFile(path.join(dir, ".agent-workflow", "project.yaml"), "utf8"), /name: billing-api/u);
  assert.equal(await ensureProjectNameFromFolder(dir), undefined, "a real name is never replaced");
});
